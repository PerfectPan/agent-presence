import { afterAll } from 'vite-plus/test';
import { isolateTestHome } from './isolated-home.js';

// Vitest runs this before each test file is imported, so every file starts with its own temporary home.
afterAll(isolateTestHome());
