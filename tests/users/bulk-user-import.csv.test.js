import { describe, expect, it } from 'vitest';
import {
  BULK_USER_CSV_HEADERS,
  makeBulkUserErrorReport,
  makeBulkUserCsvTemplate,
  parseBulkUserCsv,
} from '../../src/modules/users/bulk-user-import.csv.js';

const header = BULK_USER_CSV_HEADERS.join(',');

describe('bulk user CSV parsing', () => {
  it('parses BOM-prefixed CSV, quoted commas, whitespace, and empty rows', () => {
    const csv = `\uFEFF${header}\r\n Ada , Lovelace ,ada@example.com,,,Department Member,"Research, Systems",\r\n\r\n`;
    const [row] = parseBulkUserCsv(csv);

    expect(row).toMatchObject({
      rowNumber: 2,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      role: 'Department Member',
      designation: 'Research, Systems',
    });
  });

  it('rejects missing, duplicate, or unexpected headers and malformed quoting', () => {
    expect(() => parseBulkUserCsv('firstName,email\nAda,ada@example.com')).toThrow(/exactly the documented columns/i);
    expect(() => parseBulkUserCsv(`${header},extra\nvalue`)).toThrow(/exactly the documented columns/i);
    expect(() => parseBulkUserCsv(`${header}\nAda,"unterminated`)).toThrow(/not closed/i);
  });

  it('rejects empty CSV files and files that exceed the row limit', () => {
    expect(() => parseBulkUserCsv(' \r\n')).toThrow(/empty/i);
    expect(() => parseBulkUserCsv(`${header}\n`)).toThrow(/at least one data row/i);
    const rows = Array.from({ length: 501 }, () => 'Ada,Lovelace,ada@example.com,,,Department Member,,').join('\n');
    expect(() => parseBulkUserCsv(`${header}\n${rows}`)).toThrow(/more than 500 data rows/i);
    expect(() => parseBulkUserCsv(`${header}\n${'x'.repeat(512 * 1024)}`)).toThrow(/cannot exceed 524288 bytes/i);
  });

  it('ignores documented template instructions when the downloaded template is filled in', () => {
    const csv = `${makeBulkUserCsvTemplate()}Ada,Lovelace,ada@example.com,,,Department Member,,`;
    const [row] = parseBulkUserCsv(csv);

    expect(row).toMatchObject({
      rowNumber: 10,
      email: 'ada@example.com',
      role: 'Department Member',
    });
  });

  it('accepts legacy headers and parses an optional explicit scope column', () => {
    const legacyHeader = BULK_USER_CSV_HEADERS.slice(0, -1).join(',');
    const [legacyRow] = parseBulkUserCsv(
      `${legacyHeader}\nAda,Lovelace,ada@example.com,,,Department Member,,`,
    );
    const [scopedRow] = parseBulkUserCsv(
      `${header}\nAda,Lovelace,ada@example.com,,,Department Member,,,ORGANIZATION`,
    );

    expect(legacyRow.scope).toBe('');
    expect(scopedRow.scope).toBe('ORGANIZATION');
  });

  it('neutralizes spreadsheet formulas in downloadable reports', () => {
    const report = makeBulkUserErrorReport([{
      rowNumber: 2,
      email: '=HYPERLINK("https://example.test")',
      firstName: '+SUM(1,1)',
      lastName: '-1+2',
      department: '@SUM(1,1)',
      role: 'Department Member',
      errors: ['Invalid value'],
    }, {
      rowNumber: 3,
      email: ' \t=HYPERLINK("https://example.test")',
      firstName: '\uFEFF+SUM(1,1)',
      lastName: '\u0000@SUM(1,1)',
      department: '\u0085-1+2',
      role: 'Department Member',
      errors: ['Invalid value'],
    }]);

    expect(report).toContain("'=HYPERLINK");
    expect(report).toContain("'+SUM");
    expect(report).toContain("'-1+2");
    expect(report).toContain("'@SUM");
    expect(report).toContain("' \t=HYPERLINK");
    expect(report).toContain("'\uFEFF+SUM");
    expect(report).toContain("'\u0000@SUM");
    expect(report).toContain("'\u0085-1+2");
  });
});
