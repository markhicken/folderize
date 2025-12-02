import fs from 'fs';
import path from 'path';
import ExifImage from 'node-exif';
import { log } from './logger.js';

export function validatePath(pathArg, pathName, shouldCreate) {
  if (!pathArg) {
    log(`Please provide a ${pathName} path`, true);
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
        log(`${pathName} path "${resolvedPath}" does not exist.`, true);
        process.exit(1);
      }
    }
  }
}

export function cleanEmptyFoldersRecursively(folder, isSubFolder = false) {
  if (!fs.statSync(folder).isDirectory()) {
    return;
  }

  log('Checking for empty folders...', true);

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
    log('Removing empty folder: ' + folder, true);
    fs.rmdirSync(folder);
    return;
  }
}

// gets file with extended info such as exif data
export async function getExtendedFile(file) {
  return new Promise((resolve, reject) => {
    let updatedFile = {...file, exifData: null, filingDateSrc: 'file.createdAt', errorInfo: []};
    let filingCreatedDate = updatedFile.stats.birthtime;
    try {
      new ExifImage({image: file.path}, function (error, exifData) {
        if (error) {
          updatedFile.errorInfo.push(`Error parsing EXIF data for "${file.path}". Using file date instead - ` + error.message);
        } else {
          const exifCreateDate = exifData.exif.CreateDate || exifData.exif.DateTimeOriginal || exifData.exif.DateTimeDigitized || exifData.image.CreateDate || exifData.image.ModifyDate;
          updatedFile.filingCreatedDate = exifCreateDate || file.stats.birthtime;
          updatedFile.exifData = {...exifData};
          if (exifCreateDate) { updatedFile.filingDateSrc = `exif`; }
        }
        resolve({...updatedFile, filingCreatedDate});
      });
    } catch(error) {
      updatedFile.errorInfo.push(`No EXIF data for "${file}". Using file created date instead - ` + error.message);
      resolve({...updatedFile, filingCreatedDate});
    }
  });
};

// Get files from a path, optionally filtered by extensions
// Set includeExtendedInfo to false for a lightweight file list (skips EXIF parsing)
export async function getFiles(srcPath, extensions = null, ignoredFiles = [], includeExtendedInfo = true) {
  const {globby} = await import('globby');
  
  let files;
  try {
    let patterns;
    
    if (extensions && extensions.length > 0) {
      // Build glob patterns for specific extensions
      // caseSensitiveMatch: false handles mixed case (e.g., .mov, .MOV, .MoV)
      patterns = extensions.map(ext => `${srcPath}/**/*${ext}`);
    } else {
      // Get all files
      patterns = [
        `${srcPath}/**/.*`, // include hidden files
        `${srcPath}/**/*`
      ];
    }
    
    files = await globby(patterns, {
      stats: true, // only fetch stats when needed
      checkCwdOption: false,
      ignore: ['**/node_modules/**'],
      caseSensitiveMatch: false
    });
  } catch (error) {
    log(`Error getting files: ${error.message}`, true);
    process.exit(1);
  }

  // When extended info is requested, parse EXIF data for each file
  if (includeExtendedInfo) {
    files.length && log('Getting files info...', true);
    for (let i = 0; i < files.length; i++) {
      log(`Getting file info: (${i+1}/${files.length}) ${files[i].path}`, true);
      files[i] = await getExtendedFile(files[i]);
    }
  }

  const filesForProcessing = files.map(file => ({
    name: file.name,
    srcFilePath: file.path,
    stats: file.stats,
    filingCreatedDate: new Date(file.filingCreatedDate ?? file.stats.birthtime),
    filingDateSrc: file.filingDateSrc ?? 'file.createdAt',
    exifData: file.exifData ?? null
  })).filter(
    file => !ignoredFiles.includes(file.name)
  );
  
  return filesForProcessing;
}

export function isFileStable(filePath, maxAgeSeconds = 5) {
  const stats = fs.statSync(filePath);
  const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
  return ageSeconds >= maxAgeSeconds;
}
