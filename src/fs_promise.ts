import * as util from 'util'
import * as fs from 'fs'

export const open = util.promisify(fs.open)
export const close = util.promisify(fs.close)
export const exists = util.promisify(fs.exists)
export const stat = util.promisify(fs.stat)
export const unlink = util.promisify(fs.unlink)
export const rmdir = util.promisify(fs.rmdir)
export const readdir = util.promisify(fs.readdir)
export const readFile = util.promisify(fs.readFile)