import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Vercel Cron secret protection (set VERCEL_CRON_SECRET in env)
const CRON_SECRET = process.env.VERCEL_CRON_SECRET || 'dev-secret';

export const runtime = 'nodejs';
export const maxDuration = 60; // seconds - keep short; use --limit for batches

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronHeader = request.headers.get('x-vercel-cron');
  const secret = request.nextUrl.searchParams.get('secret');

  if (
    (authHeader !== `Bearer ${CRON_SECRET}` && secret !== CRON_SECRET) &&
    !cronHeader
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const adapter = request.nextUrl.searchParams.get('adapter') || 'generic-county';
  const limit = request.nextUrl.searchParams.get('limit') || '5';
  const dry = request.nextUrl.searchParams.get('dry') !== 'false';

  try {
    const cmd = [
      'npm', 'run', 'ingest', '--',
      '--adapter', adapter,
      '--limit', limit,
      dry ? '--dry-run' : ''
    ].filter(Boolean).join(' ');

    console.log('[cron/ingest] Running:', cmd);

    const { stdout, stderr } = await execAsync(cmd, {
      cwd: process.cwd(),
      timeout: 55000,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    return NextResponse.json({
      ok: true,
      adapter,
      limit,
      dry,
      output: stdout.slice(0, 2000),
      error: stderr ? stderr.slice(0, 500) : null,
    });
  } catch (err: any) {
    return NextResponse.json({
      ok: false,
      error: err.message || String(err),
      stdout: err.stdout?.slice(0, 1000),
    }, { status: 500 });
  }
}
