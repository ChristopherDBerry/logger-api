import express from "express";
import cors from "cors";
import multer from "multer";
import csvParser from "csv-parser";
import fs from "fs";
import swaggerUi from "swagger-ui-express";
import dotenv from 'dotenv';
import prisma from "./utils/prismaClient.js";
import { format } from 'date-fns';

const app = express();

/**************/
//   Config   //
/**************/

dotenv.config();
// eslint-disable-next-line no-undef
const PROCESS_ENV = process.env;
const AUTH_TOKEN = PROCESS_ENV.AUTH_TOKEN
const PORT = PROCESS_ENV.PORT

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
  { method: "GET", path: "/logs/aggregate" },
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
            // SQLite does not support createMany :(
            // This is inefficient but will do for now
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
  res.json({logs});
});

const TIMEFRAME_FORMATS = {
  hourly: "yyyy-MM-dd HH:00:00",
  daily: "yyyy-MM-dd 00:00:00",
  weekly: "yyyy-ww"
};

const ALLOWED_FIELDS = ['service', 'level', 'message'];

app.get('/logs/aggregate', async (req, res) => {
  try {
    const { timeframe, field, limit = 50, page = 1 } = req.query;
    const parsedLimit = parseInt(limit, 10);
    const parsedPage = parseInt(page, 10);

    if (!TIMEFRAME_FORMATS[timeframe]) {
      return res.status(400).json({ error: 'Invalid timeframe. Use hourly, daily, or weekly.' });
    }
    if (!ALLOWED_FIELDS.includes(field)) {
      return res.status(400).json({ error: 'Invalid field. Use service, level, or message.' });
    }
    if (isNaN(parsedLimit) || parsedLimit <= 0) {
      return res.status(400).json({ error: 'Invalid limit. Must be a positive number.' });
    }
    if (isNaN(parsedPage) || parsedPage <= 0) {
      return res.status(400).json({ error: 'Invalid page. Must be a positive number.' });
    }

    const logs = await prisma.log.findMany({
      select: {
        timestamp: true,
        [field]: true,
      },
      skip: (parsedPage - 1) * parsedLimit,
      take: parsedLimit
    });

    const aggregatedLogs = logs.reduce((acc, log) => {
      const formattedTime = format(new Date(log.timestamp), TIMEFRAME_FORMATS[timeframe]);
      const key = `${formattedTime}-${log[field]}`;
      if (!acc[key]) {
        acc[key] = { time: formattedTime, [field]: log[field], total: 0 };
      }
      acc[key].total += 1;
      return acc;
    }, {});

    res.json(Object.values(aggregatedLogs));
  } catch (error) {
    console.error('Error aggregating logs:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// Start Server
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));

export default app;
