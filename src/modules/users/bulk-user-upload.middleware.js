import Busboy from 'busboy';
import { TextDecoder } from 'node:util';
import { AppError } from '../../utils/AppError.js';
import { BULK_USER_CSV_MAX_BYTES } from './bulk-user-import.csv.js';

const reject = (next, message, statusCode = 400, code = 'BULK_IMPORT_UPLOAD_INVALID') =>
  next(new AppError(message, statusCode, code));

export const loadBulkUserCsv = (req, res, next) => {
  if (req.is('application/json')) {
    if (!req.body || typeof req.body.csv !== 'string' || Object.keys(req.body).some((key) => key !== 'csv')) {
      return reject(next, 'JSON bulk import requests must contain only a csv string.');
    }
    req.bulkUserCsv = req.body.csv;
    return next();
  }

  if (!req.is('multipart/form-data')) {
    return reject(next, 'Upload a CSV file using multipart/form-data with the file field.');
  }

  let parser;
  try {
    parser = Busboy({
      headers: req.headers,
      limits: { fileSize: BULK_USER_CSV_MAX_BYTES, files: 1, fields: 0 },
    });
  } catch {
    return reject(next, 'Invalid multipart upload.');
  }

  let fileCount = 0;
  let rejected = false;
  let tooLarge = false;
  let completed = false;
  const chunks = [];
  const finish = (error) => {
    if (completed) return;
    completed = true;
    if (error) return next(error);
    if (tooLarge) return reject(next, `CSV files cannot exceed ${BULK_USER_CSV_MAX_BYTES} bytes.`, 413, 'BULK_IMPORT_FILE_TOO_LARGE');
    if (rejected || fileCount !== 1) return reject(next, 'Provide exactly one CSV file in the file field.');

    try {
      const csv = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      req.bulkUserCsv = csv;
      return next();
    } catch {
      return reject(next, 'CSV files must use UTF-8 encoding.');
    }
  };

  parser.on('file', (fieldName, stream) => {
    fileCount += 1;
    if (fieldName !== 'file' || fileCount > 1) {
      rejected = true;
      stream.resume();
      return;
    }
    stream.on('limit', () => { tooLarge = true; });
    stream.on('data', (chunk) => chunks.push(chunk));
  });
  parser.on('field', () => { rejected = true; });
  parser.on('filesLimit', () => { rejected = true; });
  parser.on('fieldsLimit', () => { rejected = true; });
  parser.on('partsLimit', () => { rejected = true; });
  parser.on('error', () => finish(new AppError('Invalid multipart upload.', 400, 'BULK_IMPORT_UPLOAD_INVALID')));
  parser.on('finish', () => finish());
  req.pipe(parser);
};

export default loadBulkUserCsv;
