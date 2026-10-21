import { PrismaClient } from '@prisma/client';

// Fix BigInt serialization for JSON
BigInt.prototype.toJSON = function () {
  return this.toString();
};

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});

export default prisma;
