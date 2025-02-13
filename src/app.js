import express from "express";
import cors from "cors";
import multer from "multer";
import csvParser from "csv-parser";
import fs from "fs";
import swaggerUi from "swagger-ui-express";
import { PrismaClient } from "@prisma/client";
import dotenv from 'dotenv';

const app = express();
const prisma = new PrismaClient();


/**************/
//   Config   //
/**************/

dotenv.config();
// eslint-disable-next-line no-undef
const PROCESS_ENV = process.env;
const AUTH_TOKEN = PROCESS_ENV.AUTH_TOKEN
const PORT = PROCESS_ENV.PORT

console.log("port", PORT);

const swaggerDocs = JSON.parse(fs.readFileSync(new URL("./swagger.json", import.meta.url), "utf8"));

/**************/
// Security   //
/**************/

// PROTECTED_ROUTES is a set of routes that require an auth token
// TODO Ideally, this should be extracted from swagger.json
// This will do for now
export const PROTECTED_ROUTES = new Set([
  { method: "GET", path: "/logs" },
  { method: "DELETE", path: "/logs" },
  { method: "POST", path: "/upload" }
]);

export const authMiddleware = (req, res, next) => {
  const isProtected = [...PROTECTED_ROUTES].some(
    (route) => route.method === req.method && route.path === req.path
  );

  if (!isProtected) {
    return next();
  }

  const token = req.headers.authorization;
  if (!token || token !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
};


/**************/
// Middleware //
/**************/

app.use(cors());
app.use(express.json());
app.use(authMiddleware);

// Swagger API Docs
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Multer Setup for File Uploads
const upload = multer({ dest: "/tmp/uploads/" });

/**************/
//   Routes   //
/**************/

// TODO These would be better as separate files, leave them here for now

// Health Check
app.get("/", (req, res) => res.send("Log Viewer API is running"));

// Expose Swagger
app.get("/swagger.json", (req, res) => {
  res.json(swaggerDocs);
});

// Upload Logs CSV File
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const results = [];
  const errors = [];
  let firstRow = true;
  const filePath = req.file.path;

  const deleteFile = () => {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  };

  try {
    const stream = fs.createReadStream(filePath);

    stream
      .pipe(csvParser())
      .on('data', (data) => {
        if (firstRow) {
          firstRow = false;
          return;
        }
        try {
          if (!data.timestamp || !data.service || !data.level || !data.message) {
            throw new Error('Missing required fields');
          }

          results.push({
            timestamp: new Date(data.timestamp),
            service: data.service.trim(),
            level: data.level.trim(),
            message: data.message.trim(),
          });
        } catch (error) {
          errors.push({ row: data, error: error.message });
        }
      })
      .on('end', async () => {
        try {
          if (results.length === 0 && errors.length > 0) {
            deleteFile();
            return res.status(400).json({ error: 'All rows were invalid', details: errors });
          }

          if (results.length > 0) {
            await Promise.all(
              results.map(async (log) => {
                try {
                  await prisma.log.create({ data: log });
                } catch (error) {
                  console.error(error);
                  errors.push({ log, error: error.message });
                }
              })
            );
          }

          deleteFile();
          return res.json({
            message: 'File processed',
            recordsInserted: results.length - errors.length,
            errors,
          });
        } catch (error) {
          console.error(error);
          deleteFile();
          return res.status(500).json({ error: 'Failed to process CSV' });
        }
      })
      .on('error', (error) => {
        console.error(error);
        deleteFile();
        return res.status(500).json({ error: 'Error processing CSV file' });
      });
  } catch (error) {
    console.error(error);
    deleteFile();
    return res.status(500).json({ error: 'Unexpected error occurred' });
  }
});

// Delete all logs

app.delete('/logs', async (req, res) => {
  try {
    await prisma.log.deleteMany();
    return res.json({ message: 'All logs deleted successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to delete logs' });
  }
});

// Fetch Logs (Paginated)
app.get("/logs", async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const logs = await prisma.log.findMany({
    skip: (page - 1) * limit,
    take: parseInt(limit),
    orderBy: { timestamp: "desc" },
  });
  res.json(logs);
});

// Start Server
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

export default app;
