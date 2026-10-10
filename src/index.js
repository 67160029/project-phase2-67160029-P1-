const swaggerUi = require("swagger-ui-express");
const YAML = require("yaml");
const fs = require("fs");
const path = require("path");
const express = require("express");
const pool = require("../db");
const { searchGoogleBooks } = require("./services/external-api");

const app = express();
app.use(express.json());
const openapiDocument = YAML.parse(
  fs.readFileSync(path.join(__dirname, "../openapi.yaml"), "utf8")
);

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openapiDocument));

// ตรวจสอบว่า ID เป็นจำนวนเต็มบวก
function validId(id) {
  return Number.isInteger(Number(id)) && Number(id) > 0;
}

// 1. GET /api/books — ดูหนังสือทั้งหมด
app.get("/api/books", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT books.id, books.title, books.isbn,
        authors.name AS author,
        categories.name AS category,
        books.published_year,
        books.total_copies,
        books.available_copies
      FROM books
      JOIN authors ON books.author_id = authors.id
      JOIN categories ON books.category_id = categories.id
    `);

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database query failed" });
  }
});

// 2. GET /api/books/search?q=clean — ค้นหาหนังสือ
app.get("/api/books/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();

    if (!q) {
      return res.status(400).json({
        error: "กรุณาระบุคำค้นหาใน q",
      });
    }

    const keyword = `%${q}%`;
    const [rows] = await pool.query(
      `SELECT books.id, books.title, books.isbn,
        authors.name AS author,
        categories.name AS category,
        books.published_year,
        books.total_copies,
        books.available_copies
       FROM books
       JOIN authors ON books.author_id = authors.id
       JOIN categories ON books.category_id = categories.id
       WHERE books.title LIKE ?
          OR books.isbn LIKE ?
          OR authors.name LIKE ?`,
      [keyword, keyword, keyword]
    );

    res.json(rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database query failed" });
  }
});

// 3. GET /api/books/:id — ดูหนังสือตาม ID
app.get("/api/books/:id", async (req, res) => {
  try {
    if (!validId(req.params.id)) {
      return res.status(400).json({ error: "Invalid book ID" });
    }

    const [rows] = await pool.execute(
      `SELECT books.id, books.title, books.isbn,
        authors.name AS author,
        categories.name AS category,
        books.published_year,
        books.total_copies,
        books.available_copies
       FROM books
       JOIN authors ON books.author_id = authors.id
       JOIN categories ON books.category_id = categories.id
       WHERE books.id = ?`,
      [Number(req.params.id)]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Book not found" });
    }

    res.json(rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Database query failed" });
  }
});

// ตรวจสอบข้อมูลหนังสือสำหรับ POST และ PUT
function validateBook(body) {
  const {
    title, isbn, published_year, total_copies,
    available_copies, author_id, category_id,
  } = body;

  if (
    typeof title !== "string" || !title.trim() ||
    typeof isbn !== "string" || !isbn.trim() ||
    !Number.isInteger(published_year) ||
    !Number.isInteger(total_copies) ||
    !Number.isInteger(available_copies) ||
    !Number.isInteger(author_id) ||
    !Number.isInteger(category_id)
  ) {
    return "กรุณาระบุข้อมูลหนังสือให้ครบและใช้ชนิดข้อมูลที่ถูกต้อง";
  }

  if (
    total_copies < 0 ||
    available_copies < 0 ||
    available_copies > total_copies
  ) {
    return "จำนวนหนังสือไม่ถูกต้อง";
  }

  return null;
}

// 4. POST /api/books — เพิ่มหนังสือ
app.post("/api/books", async (req, res) => {
  const errorMessage = validateBook(req.body);

  if (errorMessage) {
    return res.status(400).json({ error: errorMessage });
  }

  const {
    title, isbn, published_year, total_copies,
    available_copies, author_id, category_id,
  } = req.body;

  try {
    const [result] = await pool.execute(
      `INSERT INTO books
        (title, isbn, published_year, total_copies,
         available_copies, author_id, category_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        title.trim(), isbn.trim(), published_year,
        total_copies, available_copies, author_id, category_id,
      ]
    );

    res.status(201).json({
      message: "Book created successfully",
      id: result.insertId,
    });
  } catch (error) {
    console.error(error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "ISBN already exists" });
    }

    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({
        error: "Author ID or category ID does not exist",
      });
    }

    res.status(500).json({ error: "Could not create book" });
  }
});

// 5. PUT /api/books/:id — แก้ไขข้อมูลหนังสือ
app.put("/api/books/:id", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: "Invalid book ID" });
  }

  const errorMessage = validateBook(req.body);

  if (errorMessage) {
    return res.status(400).json({ error: errorMessage });
  }

  const {
    title, isbn, published_year, total_copies,
    available_copies, author_id, category_id,
  } = req.body;

  try {
    const [result] = await pool.execute(
      `UPDATE books SET
        title = ?, isbn = ?, published_year = ?,
        total_copies = ?, available_copies = ?,
        author_id = ?, category_id = ?
       WHERE id = ?`,
      [
        title.trim(), isbn.trim(), published_year,
        total_copies, available_copies, author_id,
        category_id, Number(req.params.id),
      ]
    );

    if (result.affectedRows === 0) {
      const [rows] = await pool.execute(
        "SELECT id FROM books WHERE id = ?",
        [Number(req.params.id)]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: "Book not found" });
      }
    }

    res.json({ message: "Book updated successfully" });
  } catch (error) {
    console.error(error);

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ error: "ISBN already exists" });
    }

    if (error.code === "ER_NO_REFERENCED_ROW_2") {
      return res.status(400).json({
        error: "Author ID or category ID does not exist",
      });
    }

    res.status(500).json({ error: "Could not update book" });
  }
});

// 6. DELETE /api/books/:id — ลบหนังสือ
app.delete("/api/books/:id", async (req, res) => {
  if (!validId(req.params.id)) {
    return res.status(400).json({ error: "Invalid book ID" });
  }

  try {
    const [result] = await pool.execute(
      "DELETE FROM books WHERE id = ?",
      [Number(req.params.id)]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Book not found" });
    }

    res.json({ message: "Book deleted successfully" });
  } catch (error) {
    console.error(error);

    if (error.code === "ER_ROW_IS_REFERENCED_2") {
      return res.status(409).json({
        error: "Cannot delete book because related records exist",
      });
    }

    res.status(500).json({ error: "Could not delete book" });
  }
});

app.get("/api/external/books", async (req, res) => {
  const q = String(req.query.q || "").trim();

  if (!q) {
    return res.status(400).json({
      error: "กรุณาระบุคำค้นหา เช่น ?q=clean",
    });
  }

  try {
    const result = await searchGoogleBooks(q);

    // ถ้า Google Books ทำงานได้ ใช้ข้อมูลจากภายนอก
    if (result.success) {
      return res.json(result);
    }

    // Fallback: ค้นหาจากฐานข้อมูล MySQL ในเครื่อง
    const keyword = `%${q}%`;

    const [rows] = await pool.execute(
      `SELECT books.id, books.title, books.isbn,
        authors.name AS author,
        categories.name AS category,
        books.published_year,
        books.total_copies,
        books.available_copies
       FROM books
       JOIN authors ON books.author_id = authors.id
       JOIN categories ON books.category_id = categories.id
       WHERE books.title LIKE ?
          OR books.isbn LIKE ?
          OR authors.name LIKE ?`,
      [keyword, keyword, keyword]
    );

    return res.json({
      success: true,
      source: "local_fallback",
      warning: "Google Books unavailable; using local database",
      attempts: result.attempts,
      externalError: result.error,
      totalItems: rows.length,
      items: rows,
    });
  } catch (error) {
    console.error("External books endpoint failed:", error);

    return res.status(500).json({
      success: false,
      error: "ไม่สามารถค้นหาหนังสือได้",
    });
  }
});

app.listen(3000, () => {
  console.log("Server running at http://localhost:3000");
});
