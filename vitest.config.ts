import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    globals: true,
    environment: 'node',
    fileParallelism: false,
    // DB-backed тесты в beforeEach делают TRUNCATE двух десятков таблиц (список
    // рос вместе с мультиарендностью). На дефолтных 5 с они начали упираться в
    // таймаут на нагруженной машине — падали не по логике, а по времени.
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
