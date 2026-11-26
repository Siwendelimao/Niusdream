import { createHash } from 'node:crypto'

export const MEMBER_REPORT_FORMAT = 'member-turn-v2'

export function memberReportArtifact(childId: string, turnId: string, report: string): string {
  const digest = createHash('sha256').update(JSON.stringify([childId, turnId, report])).digest('hex')
  return `${MEMBER_REPORT_FORMAT}:${childId}:${turnId}:${digest}`
}

export function matchesMemberReport(artifact: string, report: string): boolean {
  const [kind, childId, turnId] = artifact.split(':')
  return kind === MEMBER_REPORT_FORMAT && !!childId && !!turnId && !!report.trim() &&
    memberReportArtifact(childId, turnId, report) === artifact
}
