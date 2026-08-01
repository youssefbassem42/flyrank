const fs = require('fs');
const path = require('path');
const { init, run, get } = require('./db');

const DEFAULT_DATA = path.join(__dirname, '..', 'week-5', 'data', 'books.jsonl');
const DATA_PATH = process.env.BOOKS_DATA || DEFAULT_DATA;

function parseLine(line) {
  const b = JSON.parse(line);
  return {
    url: b.url,
    title: b.title,
    category: b.category,
    upc: b.upc,
    product_type: b.product_type,
    price_incl_tax: b.price_incl_tax,
    price_excl_tax: b.price_excl_tax,
    tax: b.tax,
    rating: b.rating,
    in_stock: b.in_stock ? 1 : 0,
    stock_quantity: b.stock_quantity,
    number_of_reviews: b.number_of_reviews,
    description: b.description,
    image_url: b.image_url,
    scraped_at: b.scraped_at,
  };
}

async function importBooks(file = DATA_PATH) {
  await init();
  if (!fs.existsSync(file)) {
    throw new Error(`No book data found at ${file}. Run the week-5 scraper first, or set BOOKS_DATA.`);
  }
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = [];
  let buf = '';
  for await (const chunk of stream) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) lines.push(line);
    }
  }
  if (buf.trim()) lines.push(buf.trim());

  await run('DELETE FROM books');
  for (const line of lines) {
    const b = parseLine(line);
    await run(
      `INSERT OR REPLACE INTO books (
        url, title, category, upc, product_type, price_incl_tax, price_excl_tax, tax,
        rating, in_stock, stock_quantity, number_of_reviews, description, image_url, scraped_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.url, b.title, b.category, b.upc, b.product_type, b.price_incl_tax, b.price_excl_tax, b.tax,
        b.rating, b.in_stock, b.stock_quantity, b.number_of_reviews, b.description, b.image_url, b.scraped_at]
    );
  }
  const { count } = await get('SELECT COUNT(*) AS count FROM books');
  console.log(`[import] loaded ${lines.length} records, ${count} books in ${file}`);
  return count;
}

if (require.main === module) {
  importBooks().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { importBooks, parseLine };
