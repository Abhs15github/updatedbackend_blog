import mongoose from "mongoose";
import { logger } from "./utils/logger.util.js";

 export const dbConnection = async(URI) => {
  try {
    await mongoose.connect(URI, {
      useUnifiedTopology: true,
      useNewUrlParser: true,
    });
    logger.info("Successfully connected to the database", {
      meta: { method: "dbConnection" },
    });
  } catch (err) {
    logger.error(`${err}`, { meta: { method: "dbConnection" } });
  }
};


