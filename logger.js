import fs from 'fs';
import { validatePath } from './utils.js';

const LOG_FOLDER = './logs';
let LOG_FILE = null;

export function getLogFileName() {
  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/[T]/g, ' ')
    .replace(/[Z]/g, '')
    .replace(/\..+/, '')
    .replace(/:/g, '-');
  return `${LOG_FOLDER}/folderize_${timestamp}.log`;
}

export function initializeLogger() {
  LOG_FILE = getLogFileName();
  validatePath(LOG_FOLDER, 'log', true);
}

export async function log(message, persistToFile = true) {
  const timestamp = new Date().toISOString();
  const logEntry = `${timestamp} - ${message}\n`;
  console.log(message);
  if (persistToFile && LOG_FILE) {
    try {
      await fs.promises.appendFile(LOG_FILE, logEntry);
    } catch (error) {
      console.log('error writing to log file');
    }
  }
}
