import { AppError } from '../../utils/AppError.js';

export const BULK_USER_CSV_REQUIRED_HEADERS = [
  'firstName',
  'lastName',
  'email',
  'employeeId',
  'department',
  'role',
  'designation',
  'phone',
];
export const BULK_USER_CSV_HEADERS = [...BULK_USER_CSV_REQUIRED_HEADERS, 'scope'];

export const BULK_USER_CSV_MAX_BYTES = 512 * 1024;
export const BULK_USER_CSV_MAX_ROWS = 500;

const fail = (message) => {
  throw new AppError(message, 400, 'BULK_IMPORT_CSV_INVALID');
};

const parseRecords = (source) => {
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let line = 1;
  let recordLine = 1;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inQuotes) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
        if (character === '\n') line += 1;
        if (character === '\r' && source[index + 1] !== '\n') line += 1;
      }
      continue;
    }

    if (afterQuote && character !== ',' && character !== '\r' && character !== '\n' && !/\s/.test(character)) {
      fail(`Malformed CSV near line ${line}.`);
    }
    if (character === '"') {
      if (field.trim() || afterQuote) fail(`Malformed CSV near line ${line}.`);
      inQuotes = true;
      continue;
    }
    if (character === ',') {
      record.push(field.trim());
      field = '';
      afterQuote = false;
      continue;
    }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      record.push(field.trim());
      if (record.some((value) => value !== '')) records.push({ line: recordLine, values: record });
      record = [];
      field = '';
      afterQuote = false;
      line += 1;
      recordLine = line;
      continue;
    }
    if (!afterQuote) field += character;
  }

  if (inQuotes) fail(`Malformed CSV: an opening quote is not closed (line ${recordLine}).`);
  record.push(field.trim());
  if (record.some((value) => value !== '')) records.push({ line: recordLine, values: record });
  return records;
};

export const parseBulkUserCsv = (value) => {
  if (typeof value !== 'string') fail('The csv field must contain CSV text.');
  const source = value.replace(/^\uFEFF/, '');
  if (!source.trim()) fail('The CSV file is empty.');
  if (Buffer.byteLength(source, 'utf8') > BULK_USER_CSV_MAX_BYTES) {
    throw new AppError(`CSV files cannot exceed ${BULK_USER_CSV_MAX_BYTES} bytes.`, 413, 'BULK_IMPORT_FILE_TOO_LARGE');
  }

  const records = parseRecords(source);
  if (records.length === 0) fail('The CSV file must include a header row.');
  const headers = records[0].values.map((header) => header.trim().toLocaleLowerCase('en-US'));
  const requiredHeaders = BULK_USER_CSV_REQUIRED_HEADERS.map((header) => header.toLocaleLowerCase('en-US'));
  const allHeaders = BULK_USER_CSV_HEADERS.map((header) => header.toLocaleLowerCase('en-US'));
  if (new Set(headers).size !== headers.length) {
    fail('The CSV must contain exactly the documented columns, with no duplicate columns.');
  }
  const hasValidHeaders =
    (headers.length === requiredHeaders.length &&
      requiredHeaders.every((header) => headers.includes(header))) ||
    (headers.length === allHeaders.length &&
      allHeaders.every((header) => headers.includes(header)));
  if (!hasValidHeaders) {
    fail('The CSV must contain exactly the documented columns, with the optional scope column allowed.');
  }
  const missing = requiredHeaders.filter((header) => !headers.includes(header));
  const unexpected = headers.filter((header) => !allHeaders.includes(header));
  if (missing.length || unexpected.length) {
    const details = [];
    if (missing.length) details.push(`Missing columns: ${missing.join(', ')}.`);
    if (unexpected.length) details.push(`Unexpected columns: ${unexpected.join(', ')}.`);
    fail(details.join(' '));
  }

  const headerIndexes = new Map(headers.map((header, index) => [header, index]));
  const dataRecords = records.slice(1).filter(({ values }) =>
    !(values[0]?.startsWith('#') && values.slice(1).every((value) => value === ''))
  );
  if (dataRecords.length === 0) fail('The CSV must contain at least one data row.');
  if (dataRecords.length > BULK_USER_CSV_MAX_ROWS) {
    throw new AppError(`CSV files cannot contain more than ${BULK_USER_CSV_MAX_ROWS} data rows.`, 413, 'BULK_IMPORT_TOO_MANY_ROWS');
  }

  return dataRecords.map(({ line: rowNumber, values }) => {
    if (values.length > headers.length) fail(`Unexpected extra value on CSV row ${rowNumber}.`);
    const padded = [...values];
    while (padded.length < headers.length) padded.push('');
    return Object.fromEntries(BULK_USER_CSV_HEADERS.map((header) => [
      header,
      padded[headerIndexes.get(header.toLocaleLowerCase('en-US'))] || '',
    ]));
  }).map((row, index) => ({ rowNumber: dataRecords[index].line, ...row }));
};

const escapeCsvCell = (value) => {
  const text = String(value ?? '');
  const safe = /^[\s\p{Cc}\uFEFF]*[=+\-@]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
};

export const makeBulkUserCsvTemplate = () => [
  BULK_USER_CSV_HEADERS.join(','),
  '"# Instructions: use one row per role assignment. Repeat email for multiple roles."',
  '"# First name last name email and role are required."',
  '"# Use existing role names. Department-scoped roles require an active department name."',
  '"# Organization-scoped roles require an empty department. Never include organization IDs."',
  '"# Scope is optional for single-scope roles; dual-scope roles require ORGANIZATION or DEPARTMENT."',
  '"# Legacy custom roles without configured scope metadata cannot be imported safely."',
  '"# UTF-8 CSV only. Maximum 512 KiB and 500 data rows."',
  '"# employeeId designation and phone must be blank because the current profile schema does not store them."',
  '',
].join('\r\n');

export const makeBulkUserErrorReport = (rows) => {
  const headers = ['rowNumber', 'email', 'firstName', 'lastName', 'department', 'role', 'scope', 'errors'];
  return [
    headers.map(escapeCsvCell).join(','),
    ...rows.map((row) => [
      row.rowNumber,
      row.email,
      row.firstName,
      row.lastName,
      row.department,
      row.role,
      row.scopeType,
      (row.errors || []).join('; '),
    ].map(escapeCsvCell).join(',')),
  ].join('\r\n');
};

export default { parseBulkUserCsv, makeBulkUserCsvTemplate, makeBulkUserErrorReport };
