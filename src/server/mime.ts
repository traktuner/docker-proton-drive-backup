import path from 'node:path';

/**
 * Media type by file extension (case-insensitive), the same mapping the official
 * Proton CLI uses. Drive uses it for previews and thumbnails; unknown types are
 * uploaded as application/octet-stream, which is always valid.
 */
const TYPES: Record<string, string> = {
  // images
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', gif: 'image/gif', bmp: 'image/bmp',
  tif: 'image/tiff', tiff: 'image/tiff', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon',
  heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', jxl: 'image/jxl',
  dng: 'image/x-adobe-dng', cr2: 'image/x-canon-cr2', cr3: 'image/x-canon-cr3', nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw', orf: 'image/x-olympus-orf', raf: 'image/x-fuji-raf', rw2: 'image/x-panasonic-rw2',
  // video
  mp4: 'video/mp4', m4v: 'video/x-m4v', mov: 'video/quicktime', mkv: 'video/x-matroska', webm: 'video/webm',
  avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
  ts: 'video/mp2t', mts: 'video/mp2t', m2ts: 'video/mp2t', flv: 'video/x-flv',
  // audio
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/opus', wma: 'audio/x-ms-wma', aiff: 'audio/aiff',
  // documents
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  rtf: 'application/rtf', odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation',
  doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  epub: 'application/epub+zip', ics: 'text/calendar', vcf: 'text/vcard', eml: 'message/rfc822',
  // archives
  zip: 'application/zip', gz: 'application/gzip', tgz: 'application/gzip', tar: 'application/x-tar',
  bz2: 'application/x-bzip2', xz: 'application/x-xz', zst: 'application/zstd', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', iso: 'application/x-iso9660-image', dmg: 'application/x-apple-diskimage',
};

export function mediaTypeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase();
  return TYPES[ext] ?? 'application/octet-stream';
}
