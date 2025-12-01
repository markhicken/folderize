import fs from 'fs';
import path from 'path';
import { log } from './logger.js';

export function validatePath(pathArg, pathName, shouldCreate) {
  if (!pathArg) {
    log(`Please provide a ${pathName} path`);
    process.exit(1);
  } else {
    let resolvedPath = path.resolve(pathArg);
    resolvedPath = resolvedPath[resolvedPath.length-1] === '/' ? resolvedPath : resolvedPath + '/';
    if (!fs.existsSync(resolvedPath)) {
      if (shouldCreate) {
        try {
          fs.mkdirSync(resolvedPath, { recursive: true });
        } catch (error) {
          // this is primarily used for creating the log file path so we will
          // use the direct console.log if it fails
          console.log(`Cannot create folder: ${resolvedPath}`);
          process.exit(1);
        }
      } else {
        log(`${pathName} path "${resolvedPath}" does not exist.`);
        process.exit(1);
      }
    }
  }
}

export function cleanEmptyFoldersRecursively(folder, isSubFolder = false) {
  if (!fs.statSync(folder).isDirectory()) {
    return;
  }

  let files = fs.readdirSync(folder);
  if (files.length > 0) {
    files.forEach((file) => {
      const fullPath = path.join(folder, file);
      cleanEmptyFoldersRecursively(fullPath, true);
    });

    // re-evaluate files; after deleting subfolder
    // we may have parent folder empty now
    if (isSubFolder) {
      files = fs.readdirSync(folder);
    }
  }

  if (files.length === 0 && isSubFolder) {
    log('Removing: ', folder);
    fs.rmdirSync(folder);
    return;
  }
}
