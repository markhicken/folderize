# Media Organizer

This projecct is a set of scripts to help organize, transcode, and cleanup media files. It primarily handles images and videos but can also handle other files types. 

<br>
<br>



# Folderize

This script moves files into folders based on creation date. It is designed for photo/video organization. It performs the following...

1. Converts video files to .mp4 format (disabled by default, enable with --convert-videos)
1. Moves files into their output location by first using the exif creation date if present and falling back to the file system creation date. 
2. Removes any remaining empty folders from the source folder.

Files are moved into folders of the following format...

`{YEAR}/{YEAR-MONTH}`  (maybe later this will be configurable)

EX: `2023/2023-01`


## Usage

`node folderize.js <source> <destination> [options]`

### Options

- `--continuous`: Run in continuous mode, checking for files periodically (default: false)
- `--convert-videos`: Enable video conversion to MP4 (default: false)
- `--delete-originals`: Delete original files after conversion (default: false)

### Examples

**Arguments:**
```bash
# Basic usage without video conversion
node folderize.js ./source ./destination

# With video conversion enabled
node folderize.js ./source ./destination --convert-videos

# With video conversion enabled and deleting original videos after conversion is complete
node folderize.js ./source ./destination --convert-videos --delete-originals

# Continuous mode
node folderize.js ./source ./destination --continuous

# Continuous mode with video conversion and deleting original videos after conversion is complete
node folderize.js ./source ./destination --continuous --convert-videos --delete-originals
```

<br>
<br>



# Convert Videos

This project also includes a convert-videos.js script for cleaning up old folderized videos that are not already h.264 MP4 videos. 

## Usage

`node convert-videos.js <source> [options]`

### Options

- `--delete-originals`: Delete original video files after conversion (default: false)
- `--stop-on-error`: Stop processing if a video conversion fails (default: false, continues processing other files)

### Examples

```bash
# Basic usage - convert videos without deleting originals
node convert-videos.js ./source

# Convert videos and delete originals after successful conversion
node convert-videos.js ./source --delete-originals

# Stop processing if any conversion fails (instead of continuing with remaining files)
node convert-videos.js ./source --stop-on-error
```

<br>
<br>



# Dedupe Videos

This script finds and removes duplicate video files when an MP4 version exists with the same base name and matching duration. Useful for cleaning up after video conversions where original files were kept.

The script uses ffprobe to compare video durations (with a 1 second tolerance) to ensure the MP4 is a valid conversion of the original before deleting.

## Usage

`node dedupe-videos.js <source> [options]`

### Options

- `--dry-run`: Preview files that would be deleted without actually deleting (default: false)
- `--stop-on-error`: Stop processing if ffprobe fails for a file (default: false, continues processing other files)

### Examples

```bash
# Preview duplicates without deleting (recommended first step)
node dedupe-videos.js ./source --dry-run

# Find and delete duplicate video files
node dedupe-videos.js ./source

# Stop processing if ffprobe fails for any file
node dedupe-videos.js ./source --stop-on-error
```

### How it works

1. Scans for all video files recursively in the source folder
2. Groups files by directory and base name (case-insensitive)
3. For each group that has both an MP4 and non-MP4 file(s):
   - Compares durations using ffprobe
   - If durations match within 1 second, the non-MP4 file is considered a duplicate
4. Deletes duplicate files (unless `--dry-run` is specified)
