import 'dotenv/config';
// Integration tests use their own databases so they never touch dev data.
// Set TEST_META_DATABASE_URL and TEST_DEMO_DATABASE_URL to enable them.
process.env.NODE_ENV = 'test';
if (process.env.TEST_META_DATABASE_URL) {
  process.env.META_DATABASE_URL = process.env.TEST_META_DATABASE_URL;
  process.env.DEMO_DATABASE_URL = process.env.TEST_DEMO_DATABASE_URL;
  process.env.API_TOKEN = '';
} else {
  // Unit tests import modules that build (lazy) connection pools.
  process.env.META_DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused_meta';
  process.env.DEMO_DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused_demo';
}
