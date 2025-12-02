import {globby} from 'globby';
import enquirer from 'enquirer';
import path from 'path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { convertVideoFiles, checkFfmpegInstalled } from './convert-to-mp4.js';
import { log, initializeLogger } from './logger.js';
import { validatePath, getFiles } from './utils.js';
import { VIDEO_FILE_EXTENSIONS, IGNORED_FILES } from './config.js';

// Parse command-line arguments with yargs
const argv = await yargs(hideBin(process.argv))
  .positional('source', {
    describe: 'Source path for video files',
    type: 'string'
  })
  .option('delete-originals', {
    describe: 'Delete original video files after conversion',
    type: 'boolean',
    default: false
  })
  .option('stop-on-error', {
    describe: 'Stop processing other files if a conversion fails',
    type: 'boolean',
    default: false
  })
  .demandCommand(1, 'You must provide source path')
  .example('node $0 ./source', 'Convert video files to MP4')
  .example('node $0 ./source --delete-originals', 'Convert video files to MP4 with deletion of originals')
  .example('node $0 ./source --stop-on-error', 'Convert video files to MP4 and continue on errors')
  .check((argv) => {
    // Support both positional and named arguments
    const source = argv._[0] || argv.source;
    if (!source) {
      throw new Error('Please provide source path');
    }
    return true;
  })
  .argv;

// Support both positional and named arguments
let srcPath = argv._[0] || argv.source;
let deleteOriginals = argv['delete-originals'];
let stopOnError = argv['stop-on-error'];


async function checkAndCovertVideoFiles() {
  try {
    log('Starting video conversion...', true);
    checkFfmpegInstalled();
    
    // Get recursive list of video files using shared utility
    const videoFiles = await getFiles(srcPath, VIDEO_FILE_EXTENSIONS, IGNORED_FILES);
    
    if (videoFiles.length === 0) {
      log('No video files found to convert.', true);
      return true;
    }
    
    log(`Found ${videoFiles.length} video file(s) to process.`, true);
    
    // Convert with recursive file list
    await convertVideoFiles(srcPath, srcPath, deleteOriginals, videoFiles, stopOnError);
    log('Video conversion completed successfully.', true);
    return true;
  } catch (err) {
    log(`Video conversion failed: ${err.message}`, true);
    return false;
  }
}

// --- main ---
(async () => {
  // Handle graceful shutdown on SIGINT (CTRL-C)
  process.on('SIGINT', () => {
    process.exit(0);
  });

  initializeLogger();
  validatePath(srcPath, 'Source');

  try {
    const shouldContinue = await new enquirer.Confirm({
      message: `Are you sure you want to recursively convert all video files in "${srcPath}" to MP4?`
    }).run();
    if (!shouldContinue) {
      process.exit(0);
    }
  } catch (error) {
    // Handle CTRL-C or other interruptions during prompt
    process.exit(0);
  }

  // handle first run
  await checkAndCovertVideoFiles();
})();
