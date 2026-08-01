const PDFDocument = require('pdfkit');
const { all, get } = require('./db');

const COVER_BLUE = '#1f3864';
const ACCENT = '#2e75b6';
const LIGHT = '#eef3fa';
const GRAY = '#6b7280';

const MARGIN = 48;

function round1(n) {
  return Math.round(n * 10) / 10;
}

function scopeWhere(payload) {
  if (!payload || !payload.category) return { clause: '', params: [] };
  return { clause: 'WHERE category = ?', params: [payload.category] };
}

async function queryStats(payload, onProgress) {
  const { clause, params } = scopeWhere(payload);

  onProgress(10, 'aggregating totals');
  const totals = await get(
    `SELECT COUNT(*)                                AS book_count,
            COUNT(DISTINCT category)                AS category_count,
            ROUND(AVG(price_incl_tax), 2)           AS avg_price,
            ROUND(MIN(price_incl_tax), 2)           AS min_price,
            ROUND(MAX(price_incl_tax), 2)           AS max_price,
            ROUND(AVG(rating), 2)                   AS avg_rating,
            SUM(CASE WHEN in_stock = 1 THEN 1 ELSE 0 END) AS in_stock_count,
            SUM(CASE WHEN in_stock = 0 THEN 1 ELSE 0 END) AS out_of_stock_count,
            SUM(COALESCE(stock_quantity, 0))        AS total_stock
     FROM books ${clause}`,
    params
  );

  onProgress(35, 'grouping by category');
  const byCategory = await all(
    `SELECT category,
            COUNT(*)                                AS book_count,
            ROUND(AVG(price_incl_tax), 2)           AS avg_price,
            ROUND(AVG(rating), 1)                   AS avg_rating
     FROM books ${clause}
     GROUP BY category
     ORDER BY book_count DESC, category
     ${clause ? '' : 'LIMIT 100'}`,
    clause ? params : []
  );

  onProgress(55, 'rating distribution');
  const byRating = await all(
    `SELECT rating, COUNT(*) AS book_count
     FROM books ${clause}
     GROUP BY rating
     ORDER BY rating`,
    params
  );

  onProgress(70, 'price buckets');
  const priceBuckets = await all(
    `SELECT CAST(price_incl_tax / 10 AS INTEGER) * 10 AS bucket_low,
            COUNT(*) AS book_count
     FROM books ${clause}
     GROUP BY bucket_low
     ORDER BY bucket_low`,
    params
  );

  onProgress(80, 'picking top lists');
  const ratingClause = clause ? `${clause} AND rating = 5` : 'WHERE rating = 5';
  const [mostExpensive, cheapest, topRated] = await Promise.all([
    all(`SELECT title, category, price_incl_tax FROM books ${clause} ORDER BY price_incl_tax DESC, title LIMIT 10`, params),
    all(`SELECT title, category, price_incl_tax FROM books ${clause} ORDER BY price_incl_tax ASC, title LIMIT 10`, params),
    all(`SELECT title, category, rating, price_incl_tax FROM books ${ratingClause} ORDER BY price_incl_tax DESC, title LIMIT 10`, params),
  ]);

  return { totals, byCategory, byRating, priceBuckets, mostExpensive, cheapest, topRated };
}

function drawTable(doc, rows, widths, opts = {}) {
  const { header = [], headerAligns = [], aligns = [], font = 'Helvetica' } = opts;
  const rowHeight = opts.rowHeight || 18;
  const headerHeight = opts.headerHeight || 22;

  doc.save();
  doc.font(`${font}-Bold`).fontSize(9);
  doc.fillColor(COVER_BLUE).rect(MARGIN, doc.y, doc.page.width - MARGIN * 2, headerHeight).fill();
  doc.fillColor('#ffffff');
  header.forEach((h, i) => {
    const x = MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0) + 6;
    doc.text(h, x, doc.y + 6, { width: widths[i] - 12, align: headerAligns[i] || 'left' });
  });
  doc.y += headerHeight;

  doc.font(font).fontSize(9).fillColor('#111827');
  rows.forEach((row, ri) => {
    if (ri % 2 === 1) {
      doc.save().fillColor(LIGHT).rect(MARGIN, doc.y, doc.page.width - MARGIN * 2, rowHeight).fill().restore();
    }
    row.forEach((cell, i) => {
      const x = MARGIN + widths.slice(0, i).reduce((a, b) => a + b, 0) + 6;
      doc.text(String(cell), x, doc.y + 5, { width: widths[i] - 12, align: aligns[i] || 'left' });
    });
    doc.y += rowHeight;
    if (doc.y > doc.page.height - 60) doc.addPage();
  });
  doc.restore();
  doc.moveDown(0.6);
}

function bar(doc, label, value, max, color = ACCENT) {
  const labelW = 130;
  const barW = doc.page.width - MARGIN * 2 - labelW - 60;
  doc.font('Helvetica').fontSize(9).fillColor('#111827').text(label, MARGIN, doc.y, { width: labelW });
  doc.save();
  doc.fillColor(LIGHT).rect(MARGIN + labelW, doc.y - 1, barW, 10).fill();
  doc.fillColor(color).rect(MARGIN + labelW, doc.y - 1, Math.max(2, barW * (value / max)), 10).fill();
  doc.restore();
  doc.font('Helvetica-Bold').fillColor('#111827').text(String(value), MARGIN + labelW + barW + 8, doc.y - 1, { width: 50 });
  doc.moveDown(0.9);
}

function section(doc, title) {
  if (doc.y > doc.page.height - 120) doc.addPage();
  doc.moveDown(0.4);
  doc.font('Helvetica-Bold').fontSize(13).fillColor(COVER_BLUE).text(title);
  doc.moveDown(0.15);
  doc.save().fillColor(ACCENT).rect(MARGIN, doc.y - 2, 42, 2.5).fill().restore();
  doc.moveDown(0.7);
}

async function renderPdf(stats, scopeLabel, onProgress) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: 'A4', bufferPages: true });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const t = stats.totals;
    const generatedAt = new Date().toISOString();

    // ---- Cover header -------------------------------------------------
    doc.save()
      .fillColor(COVER_BLUE)
      .rect(0, 0, doc.page.width, 130)
      .fill()
      .restore();
    doc.fillColor('#ffffff')
      .font('Helvetica-Bold').fontSize(22)
      .text('Books Catalogue Report', MARGIN, 42);
    doc.font('Helvetica').fontSize(11)
      .text(`Generated ${generatedAt}  ·  scope: ${scopeLabel}`, MARGIN, 78);
    doc.font('Helvetica-Bold').fontSize(13)
      .text(`${t.book_count} books · ${t.category_count} categories`, MARGIN, 100);
    doc.y = 160;

    // ---- Key stats ----------------------------------------------------
    section(doc, 'Key Metrics');
    const metrics = [
      ['Total books', t.book_count, 'Total stock', t.total_stock],
      ['Average price', `£${t.avg_price}`, 'Price range', `£${t.min_price} – £${t.max_price}`],
      ['Average rating', `${t.avg_rating} / 5`, 'In stock', `${t.in_stock_count} (${t.out_of_stock_count} out)`],
    ];
    const mw = (doc.page.width - MARGIN * 2 - 20) / 2;
    metrics.forEach(([l1, v1, l2, v2]) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY).text(l1, MARGIN, doc.y, { width: mw });
      doc.font('Helvetica-Bold').fontSize(16).fillColor(COVER_BLUE).text(String(v1), MARGIN, doc.y + 12, { width: mw });
      doc.font('Helvetica-Bold').fontSize(10).fillColor(GRAY).text(l2, MARGIN + mw + 20, doc.y - 16, { width: mw });
      doc.font('Helvetica-Bold').fontSize(16).fillColor(COVER_BLUE).text(String(v2), MARGIN + mw + 20, doc.y, { width: mw });
      doc.moveDown(2);
    });
    doc.moveDown(0.4);

    // ---- Categories ---------------------------------------------------
    section(doc, 'Books per Category (top 15)');
    const catRows = stats.byCategory.slice(0, 15).map((c) => [c.category, c.book_count, `£${c.avg_price}`, c.avg_rating]);
    drawTable(doc, catRows, [210, 70, 80, 80], {
      header: ['Category', 'Books', 'Avg price', 'Avg rating'],
      headerAligns: ['left', 'right', 'right', 'right'],
      aligns: ['left', 'right', 'right', 'right'],
    });
    onProgress(85, 'writing category table');

    // ---- Rating distribution ------------------------------------------
    section(doc, 'Rating Distribution');
    const maxRating = Math.max(...stats.byRating.map((r) => r.book_count), 1);
    stats.byRating.forEach((r) => bar(doc, `${r.rating} star${r.rating === 1 ? '' : 's'}`, r.book_count, maxRating));

    // ---- Price histogram ----------------------------------------------
    section(doc, 'Price Distribution');
    const maxBucket = Math.max(...stats.priceBuckets.map((b) => b.book_count), 1);
    stats.priceBuckets.forEach((b) => bar(doc, `£${b.bucket_low} – £${b.bucket_low + 9}`, b.book_count, maxBucket, '#6b8e23'));

    // ---- Top lists ----------------------------------------------------
    section(doc, 'Most Expensive');
    drawTable(doc, stats.mostExpensive.map((b) => [b.title, b.category, `£${b.price_incl_tax}`]), [290, 120, 80], {
      header: ['Title', 'Category', 'Price'],
      headerAligns: ['left', 'left', 'right'],
      aligns: ['left', 'left', 'right'],
    });

    section(doc, 'Cheapest');
    drawTable(doc, stats.cheapest.map((b) => [b.title, b.category, `£${b.price_incl_tax}`]), [290, 120, 80], {
      header: ['Title', 'Category', 'Price'],
      headerAligns: ['left', 'left', 'right'],
      aligns: ['left', 'left', 'right'],
    });

    section(doc, 'Top Rated (5-star, priciest first)');
    drawTable(doc, stats.topRated.map((b) => [b.title, b.category, `${b.rating}★`, `£${b.price_incl_tax}`]), [260, 110, 50, 80], {
      header: ['Title', 'Category', 'Rating', 'Price'],
      headerAligns: ['left', 'left', 'right', 'right'],
      aligns: ['left', 'left', 'right', 'right'],
    });
    onProgress(95, 'finalising document');

    // ---- Footer -------------------------------------------------------
    const pages = doc.bufferedPageRange().count;
    doc.bufferedPageRange().start;
    for (let i = 0; i < pages; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor(GRAY).text(
        `flyrank weekly report · page ${i + 1} of ${pages} · generated ${generatedAt}`,
        MARGIN,
        doc.page.height - 30,
        { width: doc.page.width - MARGIN * 2, align: 'center' }
      );
    }

    onProgress(98, 'done');
    doc.end();
  });
}

async function buildReport(payload, onProgress) {
  const scopeLabel = payload.category ? `category: ${payload.category}` : 'all books';
  const stats = await queryStats(payload, onProgress);
  const scope = payload.category ? ` ${payload.category} ` : ' all ';
  const label = payload.category ? `category-${payload.category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : 'all-books';
  const pdf = await renderPdf(stats, scopeLabel, onProgress);
  onProgress(100);
  return {
    artifact: {
      filename: `books-report-${label}-${Date.now()}.pdf`,
      mime_type: 'application/pdf',
      size_bytes: pdf.length,
      content: pdf,
    },
    summary: {
      scope: payload.category || 'all',
      book_count: stats.totals.book_count,
      category_count: stats.totals.category_count,
      avg_price: stats.totals.avg_price,
      avg_rating: stats.totals.avg_rating,
      generated_at: new Date().toISOString(),
      sections: ['Key metrics', 'Books per category', 'Rating distribution', 'Price distribution', 'Most expensive', 'Cheapest', 'Top rated'],
      note: `SQL aggregation over ${scope}books — ${stats.totals.book_count} rows in ${stats.totals.category_count} categories`,
    },
  };
}

module.exports = { buildReport, queryStats };
