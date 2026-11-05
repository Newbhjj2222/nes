import { ensureSystemAccounts } from "../src/modules/ledger/ledger.service";
import { prisma } from "../src/lib/prisma";

async function main() {
  await ensureSystemAccounts();
  // Conversion rate is a code constant (src/config/currency.ts); record it for admin visibility only.
  await prisma.systemSetting.upsert({
    where: { key: "conversion.rwfPerNes" },
    update: {},
    create: { key: "conversion.rwfPerNes", value: 20, description: "Read-only mirror of the fixed rate. Not used for calculations." },
  });
  console.log("Seeded system ledger accounts.");
}

main().finally(() => prisma.$disconnect());
