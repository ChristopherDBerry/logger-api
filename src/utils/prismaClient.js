import {PrismaClient} from "@prisma/client";
import {Sema} from "async-sema";

// eslint-disable-next-line no-undef
const PROCESS = process;

let rawPrisma;

if(!rawPrisma)
  rawPrisma = new PrismaClient;

const writeSemaphore = new Sema(1); // 1 concurrent, serial writes only
const readSemaphore = new Sema(10); // 10 reads concurrently is OK (maybe possible to increase)

const readOperations = new Set([
  "findUnique",
  "findMany",
  "findFirst",
  "aggregate",
  "count",
  "groupBy"
]);

// Wrap the Prisma Client with a semaphore
const wrapWithSemaphore = client =>
  // eslint doesnt like Proxy

  new Proxy(client, {
    get(target, prop) {
      if(prop === "$transaction") {
        return async(...args) => {
          await writeSemaphore.acquire();
          try {
            return await target[prop](...args);
          } finally {
            writeSemaphore.release();
          }
        };
      }

      const original = target[prop];
      if(typeof original === "function") {
        return async(...args) => {
          const isReadOperation = readOperations.has(prop);
          const semaphore = isReadOperation ? readSemaphore : writeSemaphore;
          await semaphore.acquire();
          try {
            return await original.apply(target, args);
          } finally {
            semaphore.release();
          }
        };
      }
      if(typeof original === "object") return wrapWithSemaphore(original);

      return original;
    }
  });

async function initializePrisma() {
  try {
    await rawPrisma.$connect();
    console.log("Database connection initialized");

  } catch (error) {
    console.error("Failed to initialize database connection:", error);
    PROCESS.exit(1);
  }
}

await initializePrisma();

// Wrap the Prisma Client
const prisma = wrapWithSemaphore(rawPrisma);


export default prisma;
