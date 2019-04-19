import { ExtensionContext, workspace, window, Disposable,
    commands, WorkspaceFolder, OutputChannel, QuickPickItem,
    RelativePattern,
    ViewColumn
     } from 'vscode';
import * as os from 'os'
import * as proc from 'child_process'
import * as path from 'path'

import * as fs from './fs_promise'
import * as cmakeFileAPI from './cmake_file_api'
import { NAMESPACE } from './constants'

let EXTENSION_PATH: string

export function activate(context: ExtensionContext) {
    EXTENSION_PATH = context.extensionPath

    const disposables: Disposable[] = [];
    context.subscriptions.push(new Disposable(() => Disposable.from(...disposables).dispose()));

    const outputChannel = window.createOutputChannel('CMake Insights');
    disposables.push(outputChannel);
    
    commands.registerCommand(NAMESPACE + '.showDependencies', buildDir => {
        showDependencies(buildDir, outputChannel);
    });
}

async function showDependencies(buildDir: string | undefined, outputChannel: OutputChannel) {
    if (!buildDir) {
        const workspaceFolder = await maybeAskForWorkspaceFolder();
        if (!workspaceFolder) {
            return;
        }
        buildDir = await maybeAskForBuildDir(workspaceFolder);
    }
    if (!buildDir) {
        return;
    }
    await cmakeFileAPI.enable(buildDir);
    let cmakeErrored = false
    try {
        await runCMake(buildDir);
    } catch (e) {
        outputChannel.appendLine('Error re-running CMake: ' + e.message);
        cmakeErrored = true;
    }
    let codemodel: any
    try {
        codemodel = await cmakeFileAPI.readCodemodel(buildDir);
    } catch (e) {
        outputChannel.appendLine('Error reading CMake API output: ' + e.message);
        if (cmakeErrored) {
            window.showWarningMessage(
                'Please re-run CMake (>= 3.14) manually to generate API output. ' +
                `CMake API output has been enabled for ${buildDir} but ` +
                'there was an error re-running CMake automatically.'
                );
            outputChannel.show();
        } else {
            window.showErrorMessage(
                `No CMake API output found, make sure you use CMake >= 3.14.`
                );
        }
        return;
    }

    if (cmakeErrored) {
        // We were able to read the codemodel because the developer or a tool
        // re-ran CMake, since we couldn't do it ourselves for some reason.
        // However, we don't know if the last CMake run is up-to-date or
        // whether the developer made changes to CMake files that would
        // then also change the API output.
    } else {
        // If we are able to run CMake, then we don't rely on
        // the developer to manually run CMake, therefore we can immediately
        // disable the API query to avoid unnecessary slowdown and disk usage
        // each time CMake is run by the developer.
        cmakeFileAPI.disable(buildDir);
    }

    await showDependenciesWebview(codemodel);
}

async function showDependenciesWebview(codemodel: any) {
    const panel = window.createWebviewPanel(NAMESPACE + '.dependencies',
        'CMake Insights: Dependencies', ViewColumn.One, 
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });

    const webviewData = getWebviewData(codemodel);
    panel.webview.html = await getWebviewContent(webviewData);    
}

interface WebviewTargetSource {
    path: string
    isGenerated: boolean
    fromObjectLibrary: boolean
}

interface WebviewTarget {
    id: string
    type: string
    isGeneratorProvided: boolean
    name: string
    nameOnDisk: string
    projectIndex: number
    dependencies: string[] // target IDs
    sources: WebviewTargetSource[]
    languages: string[]
    definition: string // CMake file where the target was initially defined
}

interface WebviewData {
    created: number // UNIX timestamp in ms
    targets: WebviewTarget[]
    projectNames: string[]
}

function getWebviewData(codemodel: any): WebviewData {
    const config = cmakeFileAPI.getArbitraryConfiguration(codemodel);

    const data: WebviewData = {
        created: codemodel.created,
        projectNames: config.projects.map((p: any) => p.name),
        targets: config.targets.map((target: any) => ({
            id: target.id,
            type: target.type,
            isGeneratorProvided: !!target.isGeneratorProvided,
            name: target.name,
            nameOnDisk: target.nameOnDisk,
            projectIndex: target.projectIndex,
            dependencies: target.dependencies.map((d: any) => d.id),
            sources: target.sources.map((s: any) => ({
                path: s.path,
                isGenerated: s.isGenerated,
                fromObjectLibrary: target.sourceGroups[s.sourceGroupIndex].name == 'Object Libraries'
            })),
            languages: Array.from(new Set(target.compileGroups.map((g: any) => g.language) as string[])),
            definition: target.backtraceGraph.files[0]
        }))        
    };

    return data;
}

async function getWebviewContent(data: any): Promise<string> {
    const dataJson = JSON.stringify(data, null, 1);
    const htmlPath = path.join(EXTENSION_PATH, 'webview', 'dependencies.html');
    let html = await fs.readFile(htmlPath, 'utf8');
    html = html.replace('["%DATA%"]', dataJson);
    return html;
}

class WorkspaceFolderItem implements QuickPickItem {
    constructor(public workspaceFolder: WorkspaceFolder) { }

	get label(): string { return this.workspaceFolder.name; }
	get description(): string { return this.workspaceFolder.uri.fsPath; }
}

async function maybeAskForWorkspaceFolder(): Promise<WorkspaceFolder | undefined> {
    const folders = workspace.workspaceFolders
    if (!folders) {
        window.showInformationMessage('Please open a folder first');
        return;
    }
    if (folders.length === 1) {
        return folders[0];
    }
    const picks = folders.filter(f => f.uri.scheme == 'file').map(f => new WorkspaceFolderItem(f));
    // See https://github.com/Microsoft/vscode/issues/48034.
    // Currently, only findFiles() is exposed, but not other functions we would need.
    const placeHolder = 'Select a workspace folder (local only)';
    const choice = await window.showQuickPick<WorkspaceFolderItem>(picks, { placeHolder });

    if (!choice) {
        return;
    }
    return choice.workspaceFolder;
}

class BuildDirItem implements QuickPickItem {
    constructor(public buildDir: string, private workspaceFolder: WorkspaceFolder) { }

	get label(): string { return path.relative(this.workspaceFolder.uri.fsPath, this.buildDir); }
	get description(): string { return this.buildDir; }
}

async function maybeAskForBuildDir(workspaceFolder: WorkspaceFolder): Promise<string | undefined> {
    const include = new RelativePattern(workspaceFolder, '**/CMakeCache.txt');
    const matches = await workspace.findFiles(include);
    const folders = matches.map(m => path.dirname(m.fsPath));
    if (folders.length === 0) {
        window.showErrorMessage('No CMake build folder found, please run CMake first.');
        return
    }
    if (folders.length === 1) {
        return folders[0]
    }

    const picks = folders.map(f => new BuildDirItem(f, workspaceFolder));
    const placeHolder = 'Select a CMake build folder';
    const choice = await window.showQuickPick<BuildDirItem>(picks, { placeHolder });

    if (!choice) {
        return;
    }
    return choice.buildDir;
}

async function runCMake(buildDir: string): Promise<void> {
    const cmakeExe = await readCMakeExePath(buildDir);
    const opts: proc.SpawnOptions = {
        cwd: buildDir,
        stdio: ['ignore', 'ignore', 'pipe']
    };
    const child = proc.spawn(cmakeExe, ['.'], opts);
    let stderr = ''
    child.stderr.on('data', (data) => {
        stderr += data;
    });
    return new Promise((resolve, reject) => {
        child.on('error', (err) => {
            reject(err);
        });
        child.on('exit', (code, signal) => {
            if (code != 0) {
                reject(stderr);
            }
            resolve();
        });
    })
}

async function readCMakeExePath(buildDir: string): Promise<string> {
    const cacheFile = path.join(buildDir, 'CMakeCache.txt')
    const cacheLines = (await fs.readFile(cacheFile, {encoding: 'utf-8'})).split(/\r?\n/);
    const prefix = 'CMAKE_COMMAND:INTERNAL='
    const cmakeCmdLine = cacheLines.find(l => l.startsWith(prefix))
    if (!cmakeCmdLine) {
        throw new Error('Unable to find CMAKE_COMMAND cache variable');
    }
    const cmakeCmd = cmakeCmdLine.substr(prefix.length);
    if (!(await fs.exists(cmakeCmd))) {
        throw new Error(`CMake executable not found: ${cmakeCmd}`)
    }
    return cmakeCmd;
}
