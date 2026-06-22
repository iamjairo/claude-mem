#!/usr/bin/env node
const fs = require('fs');

const MAX_RELEASES = Number.parseInt(process.env.MAX_RELEASES ?? '50', 10);

function exitWithError(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function formatRelease(release) {
  if (!release || typeof release !== 'object') {
    throw new Error('Invalid release entry');
  }

  const { tag_name, published_at, body } = release;

  if (!tag_name) {
    throw new Error('Release is missing tag_name');
  }

  const date = new Date(published_at);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid published_at for release ${tag_name}`);
  }

  const isoDate = date.toISOString().split('T')[0];
  const lines = [`## [${tag_name}] - ${isoDate}`, ''];

  if (body && body.trim()) {
    lines.push(body.trim(), '');
  } else {
    lines.push('');
  }

  return lines;
}

function generate() {
  const input = fs.readFileSync(0, 'utf8');

  if (!input.trim()) {
    exitWithError('No input received on stdin');
  }

  let releases;
  try {
    releases = JSON.parse(input);
  } catch {
    exitWithError('Error: stdin must be valid JSON');
  }

  if (!Array.isArray(releases)) {
    exitWithError('Error: Input must be a JSON array');
  }

  const limit = Number.isFinite(MAX_RELEASES) && MAX_RELEASES > 0 ? MAX_RELEASES : 50;
  const lines = ['# Changelog', '', 'All notable changes to this project.', ''];

  for (const release of releases.slice(0, limit)) {
    lines.push(...formatRelease(release));
  }

  process.stdout.write(lines.join('\n') + '\n');
}

generate();
