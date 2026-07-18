// Shared footer for every outgoing Vellon email (ride receipts, dispatch-report
// notifications, student verification) — same visual language as vellon-ops'
// invoice email footer, kept in sync manually since these are separate
// deployables (Deno Edge Functions vs. the Next.js hub). No mailing address
// here: unlike vellon-ops (which has a live Configuration table), these
// functions have no config source for one, and Vellon isn't incorporated yet
// anyway — add one once there's a real address and a place to read it from.

export function emailFooter(): string {
  const year = new Date().getFullYear();
  return `
  <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #E5E7EB; text-align: center;">
    <p style="margin: 0; font-size: 11px; color: #9CA3AF;">
      Vellon &middot; <a href="mailto:support@vellon.ca" style="color: #9CA3AF;">support@vellon.ca</a>
    </p>
    <p style="margin: 4px 0 0; font-size: 11px; color: #9CA3AF;">&copy; ${year} Vellon. All rights reserved.</p>
  </div>
  `;
}
