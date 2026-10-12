import dotenv from 'dotenv';
import { startMailIntake } from './src/mail-intake.js';
import { startServer } from './src/server.js';
dotenv.config();
startServer();
startMailIntake();
