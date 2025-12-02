// Shared configuration constants
export const IGNORED_FILES = [
  '.DS_Store', 
  'Thumbs.db'
];

export const VIDEO_FILE_EXTENSIONS = [
  '.mov', 
  '.mp2', 
  '.mpg', 
  '.mpeg', 
  '.mp4', 
  '.m4v', 
  '.avi', 
  '.wmv', 
  '.flv', 
  '.mkv', 
  '.webm'
].map(ext => ext.toLowerCase());

export const ALLOWED_FILE_EXTENSIONS = [
  '.jpg', 
  '.jpeg', 
  '.gif', 
  '.heic', 
  '.raw', 
  '.cr2', 
  '.nef', 
  // '.png', (png tends to be iPhone screenshots and garbage images)
  ...VIDEO_FILE_EXTENSIONS,
].map(ext => ext.toLowerCase());
