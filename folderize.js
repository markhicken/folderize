import {globby} from 'globby';
import enquirer from 'enquirer';
import fs from 'fs';
import path from 'path';
import { utimesSync } from 'utimes';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { convertVideoFiles, checkFfmpegInstalled } from './convert-to-mp4.js';
import { log, initializeLogger } from './logger.js';
import { cleanEmptyFoldersRecursively, validatePath, getFiles, isFileStable } from './utils.js';
import { ALLOWED_FILE_EXTENSIONS, VIDEO_FILE_EXTENSIONS, IGNORED_FILES } from './config.js';

const CONTINUOUS_INTERVAL = 1000 * 60 * 60; // minutes

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


async function moveFiles(_srcPath, _dstPath) {
  // Get files using shared utility
  const files = await getFiles(_srcPath, ALLOWED_FILE_EXTENSIONS, IGNORED_FILES);

  const filesForFiling = files.map(file => {
    const filingDate = new Date(file.filingCreatedDate);
    const month = ('0' + (filingDate.getMonth() + 1)).slice(-2);
    const dstFolder = `${_dstPath}/${filingDate.getFullYear()}/${filingDate.getFullYear()}-${month}/`;
    return {
      name: file.name,
      srcFilePath: file.srcFilePath,
      dstPath: dstFolder,
      dstFilePath: dstFolder + file.name,
      stats: file.stats,
    };
  });

  files.length && log('Moving files...', true);
  filesForFiling.forEach((file, index) => {
    // check if folder exists
    if(!fs.existsSync(file.dstPath)) {
      try {
        fs.mkdirSync(file.dstPath, { recursive: true });
      }
      catch(error) {
        log(`Error creating "${file.dstPath}" - ` + error.message, true);
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
      log(`(${index+1}/${filesForFiling.length}) Error moving "${file.srcFilePath}" to "${file.dstFilePath}" - ` + error.message, true);
    }
  });
}

function verifyAllVideosConverted(videoFiles) {
  const unconverted = videoFiles.filter(file => {
    const ext = path.extname(file.srcFilePath).toLowerCase();
    
    // .mp4 files are considered already converted
    if (ext === '.mp4') {
      return false;
    }
    
    // Check if corresponding .mp4 exists
    const baseName = path.basename(file.srcFilePath, ext);
    const dir = path.dirname(file.srcFilePath);
    const mp4Path = path.join(dir, `${baseName}.mp4`);
    
    return !fs.existsSync(mp4Path);
  });
  
  return unconverted.length === 0;
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

    // Get recursive list of video files using shared utility
    const videoFiles = await getFiles(srcPath, VIDEO_FILE_EXTENSIONS, IGNORED_FILES);

    await convertVideoFiles(srcPath, deleteOriginals, videoFiles);
    log('Video conversion completed successfully.', true);
    
    // Verify all videos are converted before proceeding
    log('Verifying all video files have been converted...', true);
    
    // Get fresh list of video files
    const remainingVideoFiles = await getFiles(srcPath, VIDEO_FILE_EXTENSIONS, IGNORED_FILES);
    
    // Check for unstable files (actively being uploaded/modified)
    const unstableFiles = remainingVideoFiles.filter(file => !isFileStable(file.srcFilePath));
    if (unstableFiles.length > 0) {
      log(`Found ${unstableFiles.length} file(s) that are still being modified. Waiting for next check...`, true);
      unstableFiles.forEach(file => {
        log(`  - ${file.srcFilePath}`, true);
      });
      return false;
    }
    
    // Verify all stable videos are converted
    if (!verifyAllVideosConverted(remainingVideoFiles)) {
      const unconverted = remainingVideoFiles.filter(file => {
        const ext = path.extname(file.srcFilePath).toLowerCase();
        if (ext === '.mp4') return false;
        const baseName = path.basename(file.srcFilePath, ext);
        const dir = path.dirname(file.srcFilePath);
        const mp4Path = path.join(dir, `${baseName}.mp4`);
        return !fs.existsSync(mp4Path);
      });
      
      log(`Found ${unconverted.length} unconverted video file(s). Waiting for next check...`, true);
      unconverted.forEach(file => {
        log(`  - ${file.srcFilePath}`, true);
      });
      return false;
    }
    
    log('All video files have been converted successfully.', true);
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
    log('Skipping file folderization due to video conversion failure.', true);
    return;
  }

  await log('Checking for files to folderize...', true);
  await moveFiles(srcPath, dstPath);
  if (continuous) {
    log(`Waiting ${CONTINUOUS_INTERVAL/1000/60} minutes to check for more files.`, true);
  }
}

// --- main ---
(async () => {
  // Handle graceful shutdown on SIGINT (CTRL-C)
  process.on('SIGINT', () => {
    process.exit(0);
  });

  initializeLogger();
  continuous && await log('Folderize started.', true);
  validatePath(srcPath, 'Source');
  validatePath(dstPath, 'Destination');

  if (!continuous) {
    try {
      const shouldContinue = await new enquirer.Confirm({
        message: `Are you sure you want to move all files from "${srcPath}" to "${dstPath}/{year}/{year-month}"?`
      }).run();
      if (!shouldContinue) {
        process.exit(0);
      }
    } catch (error) {
      // Handle CTRL-C or other interruptions during prompt
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
    // clean up after single runs
    try {
      cleanEmptyFoldersRecursively(srcPath);
    } catch (error) {
      // Handle CTRL-C or other interruptions during prompt
      process.exit(0);
    }
  }
})();
