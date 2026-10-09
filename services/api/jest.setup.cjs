const fs = require('node:fs');
const path = require('node:path');

const envPath = path.resolve(__dirname, '.env');

const envContent = fs.existsSync(envPath)
  ? fs.readFileSync(envPath, 'utf8')
  : '';

for (const rawLine of envContent.split(/\r?\n/)) {
  const line = rawLine.trim();

  if (
    !line ||
    line.startsWith('#')
  ) {
    continue;
  }

  const separatorIndex =
    line.indexOf('=');

  if (separatorIndex <= 0) {
    continue;
  }

  const key =
    line
      .slice(0, separatorIndex)
      .trim();

  let value =
    line
      .slice(separatorIndex + 1)
      .trim();

  if (
    value.length >= 2 &&
    (
      (
        value.startsWith('"') &&
        value.endsWith('"')
      ) ||
      (
        value.startsWith("'") &&
        value.endsWith("'")
      )
    )
  ) {
    value = value.slice(
      1,
      -1,
    );
  }

  if (
    !process.env[key]
  ) {
    process.env[key] = value;
  }
}

if (
  !process.env.DATABASE_URL
) {
  throw new Error(
    'DATABASE_URL is required for Jest integration tests.',
  );
}