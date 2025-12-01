import {globby} from 'globby';
import ExifImage from 'node-exif';
import enquirer from 'enquirer';
import fs from 'fs';
import path from 'path';
import { utimesSync } from 'utimes';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { convertVideoFiles, checkFfmpegInstalled } from './convert-to-mp4.js';
import { log, initializeLogger } from './logger.js';
import { cleanEmptyFoldersRecursively, validatePath } from './utils.js';

const CONTINUOUS_INTERVAL = 1000 * 60 * 60; // minutes
const IGNORED_FILES = ['.DS_Store', 'Thumbs.db'];
export const VIDEO_FILE_EXTENSIONS = ['.mov', '.mp4', '.m4v', '.avi', '.wmv', '.flv', '.mkv', '.webm'];
const ALLOWED_FILE_EXTENSIONS = [
  '.jpg', '.jpeg', '.gif', '.heic', '.raw', '.cr2', '.nef', // '.png', (png tends to be iPhone screenshots and garbage images)
  ...VIDEO_FILE_EXTENSIONS,
].map(ext => ext.toLowerCase());

// Parse command-line arguments with yargs
const argv = await yargs(hideBin(process.argv))
  .positional('source', {
    describe: 'Source path for files to folderize',
    type: 'string'
  })
  .positional('destination', {
    describe: 'Destination path for organized files',
    type: 'string'
  })
  .option('continuous', {
    describe: 'Run in continuous mode, checking for files periodically',
    type: 'boolean',
    default: false
  })
  .option('convert-videos', {
    describe: 'Enable video conversion to MP4',
    type: 'boolean',
    default: false
  })
  .option('delete-originals', {
    describe: 'Delete original video files after conversion',
    type: 'boolean',
    default: false
  })
  .demandCommand(2, 'You must provide source and destination paths')
  .example('node $0 ./source ./destination', 'Move files from source to destination')
  .example('node $0 ./source ./destination --convert-videos', 'Enable video conversion')
  .example('node $0 ./source ./destination --convert-videos --delete-originals', 'Enable video conversion with deletion of originals')
  .example('node $0 ./source ./destination --continuous', 'Run in continuous mode')
  .check((argv) => {
    // Support both positional and named arguments
    const source = argv._[0] || argv.source;
    const destination = argv._[1] || argv.destination;
    
    if (!source || !destination) {
      throw new Error('Please provide both source and destination paths');
    }
    return true;
  })
  .argv;

// Support both positional and named arguments
let srcPath = argv._[0] || argv.source;
let dstPath = argv._[1] || argv.destination;
let continuous = argv.continuous;
let videoConversionEnabled = argv['convert-videos'];
let deleteOriginals = argv['delete-originals'];


// gets file with extended info such as exif data
async function getExtendedFile(file) {
  return new Promise((resolve, reject) => {
    let updatedFile = {...file, exifData: null, filingDateSrc: 'file.createdAt', errorInfo: []};
    let filingCreatedDate = updatedFile.stats.birthtime;
    try {
      new ExifImage({image: file.path}, function (error, exifData) {
        if (error) {
          updatedFile.errorInfo.push(`Error parsing EXIF data for "${file.path}". Using file date instead - ` + error.message);
        } else {
          const exifCreateDate = exifData.exif.CreateDate || exifData.exif.DateTimeOriginal || exifData.exif.DateTimeDigitized || exifData.image.ModifyDate || exifData.image.CreateDate;
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

async function moveFiles(_srcPath, _dstPath) {
  // no need to recurse because of globby
  let files;
  try {
    files = await globby([
      _srcPath + '/**/.*', // include hidden files
      _srcPath + '/**/*'
    ], {
      stats: true,
      checkCwdOption: false,
      ignore: ['**/node_modules/**']
    });
  } catch (error) {
    process.exit(error);
  }

  files.length && log('Getting files info...');
  for(let i=0; i<files.length; i++) {
    log(`Getting file info: (${i+1}/${files.length}) ${files[i].path}`, false);
    files[i] = await getExtendedFile(files[i]);
  }

  const filesForFiling = files.map(file => {
    const filingDate = new Date(file.filingCreatedDate);
    const month = ('0' + (filingDate.getMonth() + 1)).slice(-2);
    const dstFolder = `${_dstPath}/${filingDate.getFullYear()}/${filingDate.getFullYear()}-${month}/`;
    return {
      name: file.name,
      srcFilePath: file.path,
      dstPath: dstFolder,
      dstFilePath: dstFolder + file.name,
      stats: file.stats,
    };
  });

  files.length && log('Creating folders...');
  filesForFiling.forEach((file, index) => {
    // check if folder exists
    if(!fs.existsSync(file.dstPath)) {
      try {
        fs.mkdirSync(file.dstPath, { recursive: true });
      }
      catch(error) {
        log(`Error creating "${file.dstPath}" - ` + error.message);
      }
    }

    // do the move
    try {
      if (IGNORED_FILES.includes(file.name)) {
        throw {message: 'file is in the ignored files list'};
      }

      const fileExtension = path.extname(file.name).toLowerCase()
      if (!ALLOWED_FILE_EXTENSIONS.includes(fileExtension)) {
        throw {message: `file extension ${fileExtension} is ignored`};
      }

      if(fs.existsSync(file.dstFilePath)) {
        throw {message: 'destination already exists'};
      }

      // fs.renameSync only works if src and dst are on the same drive so we'll copy and unlink instead
      fs.copyFileSync(file.srcFilePath, file.dstFilePath);
      // to retain timestamps
      utimesSync(file.dstFilePath, {
        btime: Math.floor(file.stats.birthtimeMs || file.stats.btimeMs),
        mtime: Math.floor(file.stats.mtimeMs),
        atime: Math.floor(file.stats.atimeMs)
      });
      fs.unlinkSync(file.srcFilePath);
      log(`(${index+1}/${filesForFiling.length}) Moved "${file.srcFilePath}" to "${file.dstFilePath}"`);
    } catch (error) {
      log(`(${index+1}/${filesForFiling.length}) Error moving "${file.srcFilePath}" to "${file.dstFilePath}" - ` + error.message);
    }
  });
}

async function checkAndCovertVideoFiles() {
  // Convert video files in the source folder using the imported converter.
  if (!videoConversionEnabled) {
    log('Video conversion plugin is disabled.', true);
    return true;
  }

  try {
    log('Starting video conversion step...', true);
    checkFfmpegInstalled();
    await convertVideoFiles(srcPath, srcPath, deleteOriginals); // convert in place, delete originals
    log('Video conversion completed successfully.', true);
    return true;
  } catch (err) {
    log(`Video conversion failed: ${err.message}`, true);
    return false;
  }
}

let checkCount = 0;
async function checkAndFolderize() {
  checkCount++;

  // periodically log the source and destination paths
  if (checkCount % 10 === 0) {
    log(`Source Path: ${srcPath}\r\n` + `Destination Path: ${dstPath}`);
  } 

  // check and convert video files
  const videosConverted = await checkAndCovertVideoFiles();
  if (!videosConverted) {
    log('Skipping file folderization due to video conversion failure.', false);
    return;
  }

  await log('Checking for files to folderize...');
  await moveFiles(srcPath, dstPath);
  if (continuous) {
    log(`Waiting ${CONTINUOUS_INTERVAL/1000/60} minutes to check for more files.`)
  }
}

// --- main ---
(async () => {
  initializeLogger();
  continuous && await log('Folderize started.');
  validatePath(srcPath, 'Source');
  validatePath(dstPath, 'Destination');

  if (!continuous) {
    const shouldContinue = await new enquirer.Confirm({
      message: `Are you sure you want to move all files from "${srcPath}" to "${dstPath}/{year}/{year-month}"?`
    }).run();
    if (!shouldContinue) {
      process.exit(0);
    }
  }

  // handle first run
  await checkAndFolderize();

  if (continuous) {
    // Set up periodic runs
    setInterval(async() => {
      await checkAndFolderize();
    }, CONTINUOUS_INTERVAL);
  } else {
    // offer to clean up after single runs
    const shouldCleanup = await new enquirer.Confirm({
      message: `Would you like to remove empty folders from "${srcPath}"?`
    }).run();
    if (shouldCleanup) {
      cleanEmptyFoldersRecursively(srcPath);
    }
  }
})();
