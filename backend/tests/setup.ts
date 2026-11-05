process.env.NODE_ENV = "test";
process.env.DATABASE_URL ??= "postgresql://nes:nes_password@localhost:5432/nes_test?schema=public";
process.env.JWT_SECRET ??= "test-jwt-secret-test-jwt-secret-1234";
process.env.COOKIE_SECRET ??= "test-cookie-secret-test-cookie-1234";
process.env.API_KEY_PEPPER ??= "test-pepper-test-pepper-test-pepper-1";
process.env.WEBHOOK_SIGNING_SECRET ??= "test-webhook-secret-test-webhook-12";
process.env.PAWAPAY_BASE_URL = "https://api.sandbox.pawapay.io";
process.env.PAWAPAY_PROVIDERS = "MTN_MOMO_RWA";
process.env.WITHDRAWALS_ENABLED = "true"; // enabled only inside the test process
