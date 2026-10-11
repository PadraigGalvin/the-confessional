// Reads and writes the spreadsheets: the booth's index.csv and the running order.
// Spreadsheet apps re-save CSV files their own way: semicolons instead of commas
// in much of Europe, a byte-order mark, CRLF line endings, quotes only where
// needed. Parsing accepts all of those, and writing keeps the file's delimiter.

export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) => (count(firstLine, d) > count(firstLine, best) ? d : best), ',');

  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      record.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field || record.length) {
    record.push(field);
    records.push(record);
  }

  const [header = [], ...body] = records;
  const columns = header.map((column) => column.trim());
  const rows = body
    .filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(columns.map((column, i) => [column, (values[i] ?? '').trim()])));
  return { columns, rows, delimiter };
}

export function formatCsv(columns, rows, delimiter = ',') {
  const field = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const lines = [columns, ...rows.map((row) => columns.map((column) => row[column]))]
    .map((values) => values.map(field).join(delimiter));
  // The BOM makes Excel open the file as UTF-8, so accented names survive.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function count(text, char) {
  return text.split(char).length - 1;
}
