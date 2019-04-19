import * as path from 'path'
import * as util from 'util'
import glob_ from 'glob'
import mkdirp from 'mkdirp'
import * as fs from './fs_promise'

const glob = util.promisify(glob_)

const CLIENT_ID = 'insights'

function getAPIDir(buildDir: string): string {
    return path.join(buildDir, '.cmake', 'api', 'v1');
}

function getClientQueryDir(buildDir: string): string {
    const apiDir = getAPIDir(buildDir);
    const queryDir = path.join(apiDir, 'query')
    const clientQueryDir = path.join(queryDir, `client-${CLIENT_ID}`)
    return clientQueryDir;
}

async function mkdirRecursive(dir: string): Promise<void> {
    // TODO switch to "await mkdir(dir, {recursive: true})"
    //      once vscode updates to node 10.12
    mkdirp.sync(dir);
}

export async function enable(buildDir: string): Promise<void> {
    const clientQueryDir = getClientQueryDir(buildDir);
    await mkdirRecursive(clientQueryDir);
    const codemodelQueryFile = path.join(clientQueryDir, 'codemodel-v2')
    const fd = await fs.open(codemodelQueryFile, 'w');
    await fs.close(fd);
}

export async function disable(buildDir: string): Promise<void> {
    const clientQueryDir = getClientQueryDir(buildDir);
    await rmdirRecursive(clientQueryDir);
}

async function rmdirRecursive(dir: string): Promise<void> {
    if (!(await fs.exists(dir))) return;
    if (!(await fs.stat(dir)).isDirectory()) {
        await fs.unlink(dir);
        return;
    }
    for (const f of await fs.readdir(dir)) {
        await rmdirRecursive(path.join(dir, f));
    }
    await fs.rmdir(dir);
}

export async function readCodemodel(buildDir: string): Promise<any> {
    // TODO add retry logic in case cmake is running and deleting old files while we read
    const replyDir = path.join(buildDir, '.cmake', 'api', 'v1', 'reply');
    const indexFiles = await glob(path.join(replyDir, 'index-*.json'));
    if (indexFiles.length === 0) {
        throw new Error('No index file found');
    }
    indexFiles.sort();
    const indexFile = indexFiles[indexFiles.length - 1];
    const index = await readJSON(indexFile);
    const indexCreated = (await fs.stat(indexFile)).birthtimeMs;
    const reply = index.reply[`client-${CLIENT_ID}`];
    const codemodel = await readJSON(path.join(replyDir, reply['codemodel-v2'].jsonFile));
    codemodel.created = indexCreated;
    const configs = codemodel.configurations;
    for (const config of configs) {
        config.indexedTargets = {};
        for (const target of config.targets) {
            const targetDetail = await readJSON(path.join(replyDir, target.jsonFile));
            Object.assign(target, targetDetail);
            config.indexedTargets[target.id] = target;
            if (target.compileGroups === undefined) {
                target.compileGroups = [];
            }
            if (target.dependencies === undefined) {
                target.dependencies = [];
            }
        }
    }
    return codemodel;
}

export function getArbitraryConfiguration(codemodel: any): any {
    return codemodel.configurations[0];
}

async function readJSON(file: string): Promise<any> {
    const content = await fs.readFile(file, {encoding: 'utf-8'});
    return JSON.parse(content);
}