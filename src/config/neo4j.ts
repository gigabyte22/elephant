import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';
import { loadEnv } from './env.ts';

let driver: Driver | undefined;

export function getDriver(): Driver {
  if (driver) return driver;
  const env = loadEnv();
  driver = neo4j.driver(env.NEO4J_URI, neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD), {
    maxConnectionPoolSize: 50,
    connectionAcquisitionTimeout: 30_000,
    disableLosslessIntegers: true,
  });
  return driver;
}

export async function verifyConnectivity(): Promise<void> {
  await getDriver().verifyConnectivity();
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = undefined;
  }
}

function session(): Session {
  const env = loadEnv();
  return getDriver().session({ database: env.NEO4J_DATABASE });
}

export async function read<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const s = session();
  try {
    return await s.executeRead(work);
  } finally {
    await s.close();
  }
}

export async function write<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const s = session();
  try {
    return await s.executeWrite(work);
  } finally {
    await s.close();
  }
}
