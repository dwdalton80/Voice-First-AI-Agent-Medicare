// Oklahoma & Texas Medicare Eligibility Logic
// Key rule: Neither OK nor TX has a birthday rule for Medigap
// Guaranteed issue is limited to initial enrollment periods and specific federal SEPs

const AEP_START_MONTH = 10; // October
const AEP_START_DAY = 15;
const AEP_END_MONTH = 12;
const AEP_END_DAY = 7;

function checkEligibilityWindows(clients) {
  const alerts = [];
  const today = new Date();
  const todayUTC = new Date(today.toDateString());

  for (const client of clients) {
    const clientState = (client.state || '').toUpperCase();
    const isOKorTX = ['OK', 'TX'].includes(clientState);

    // ── T65 Initial Enrollment Window ─────────────────────────────────────────
    if (client.dob || client.part_b_effective) {
      const referenceDate = client.part_b_effective
        ? new Date(client.part_b_effective)
        : getPartBEffectiveFromDOB(client.dob);

      if (referenceDate) {
        const daysUntil = Math.round((referenceDate - todayUTC) / (1000 * 60 * 60 * 24));
        const daysSince = -daysUntil;

        // Alert at 90, 60, 30 days before and on the date
        if ([90, 60, 30].includes(daysUntil)) {
          alerts.push({
            type: 'T65_WINDOW',
            client_name: client.name,
            client_id: client.sparkadvisor_id || client.id,
            days_until: daysUntil,
            message: `${client.name} turns 65 in ${daysUntil} days — Medicare Initial Enrollment Window opens soon.`,
            priority: daysUntil <= 30 ? 'high' : 'normal',
          });
        }

        // Medigap OEP: 6 months from Part B effective date
        if (daysSince >= 0 && daysSince <= 180) {
          const medigapWindowCloses = new Date(referenceDate);
          medigapWindowCloses.setMonth(medigapWindowCloses.getMonth() + 6);
          const daysLeftInOEP = Math.round((medigapWindowCloses - todayUTC) / (1000 * 60 * 60 * 24));

          if (daysLeftInOEP <= 30 && daysLeftInOEP > 0) {
            alerts.push({
              type: 'MEDIGAP_OEP_CLOSING',
              client_name: client.name,
              client_id: client.sparkadvisor_id || client.id,
              days_remaining: daysLeftInOEP,
              message: `${client.name}'s Medigap guaranteed issue window closes in ${daysLeftInOEP} days.${isOKorTX ? ' (No birthday rule in ' + clientState + ')' : ''}`,
              priority: daysLeftInOEP <= 14 ? 'high' : 'normal',
            });
          }
        }
      }
    }

    // ── AEP Window ────────────────────────────────────────────────────────────
    const aepStart = new Date(today.getFullYear(), AEP_START_MONTH - 1, AEP_START_DAY);
    const aepEnd = new Date(today.getFullYear(), AEP_END_MONTH - 1, AEP_END_DAY);
    const daysToAEP = Math.round((aepStart - todayUTC) / (1000 * 60 * 60 * 24));
    const duringAEP = todayUTC >= aepStart && todayUTC <= aepEnd;

    if (daysToAEP > 0 && daysToAEP <= 30) {
      // AEP approaching — flag all active MA/PDP clients
      if (client.current_plan) {
        alerts.push({
          type: 'AEP_APPROACHING',
          client_name: client.name,
          client_id: client.sparkadvisor_id || client.id,
          days_until_aep: daysToAEP,
          message: `AEP starts in ${daysToAEP} days — ${client.name} should review their ${client.current_plan} plan.`,
          priority: daysToAEP <= 14 ? 'high' : 'normal',
        });
      }
    }

    if (duringAEP && client.current_plan) {
      alerts.push({
        type: 'AEP_ACTIVE',
        client_name: client.name,
        client_id: client.sparkadvisor_id || client.id,
        message: `AEP is active — ${client.name} can make plan changes through December 7th.`,
        priority: 'normal',
      });
    }

    // ── SEP Triggers ──────────────────────────────────────────────────────────
    if (client.loss_of_coverage_date) {
      const lossDate = new Date(client.loss_of_coverage_date);
      const sepDeadline = new Date(lossDate);
      sepDeadline.setDate(sepDeadline.getDate() + 63); // 63-day SEP window
      const daysToDeadline = Math.round((sepDeadline - todayUTC) / (1000 * 60 * 60 * 24));

      if (daysToDeadline >= 0 && daysToDeadline <= 30) {
        alerts.push({
          type: 'SEP_LOSS_OF_COVERAGE',
          client_name: client.name,
          client_id: client.sparkadvisor_id || client.id,
          days_remaining: daysToDeadline,
          message: `${client.name} has a loss-of-coverage SEP — ${daysToDeadline} days remaining to enroll.`,
          priority: daysToDeadline <= 14 ? 'high' : 'normal',
        });
      }
    }

    if (client.medicaid_status_changed) {
      alerts.push({
        type: 'SEP_DUAL_ELIGIBLE',
        client_name: client.name,
        client_id: client.sparkadvisor_id || client.id,
        message: `${client.name} has a Medicaid status change — may qualify for Dual Eligible SEP or D-SNP.`,
        priority: 'high',
      });
    }

    // Texas-specific: Star Rating SEP
    if (clientState === 'TX' && client.plan_star_rating && client.plan_star_rating < 3) {
      alerts.push({
        type: 'SEP_LOW_STAR_RATING',
        client_name: client.name,
        client_id: client.sparkadvisor_id || client.id,
        message: `${client.name}'s plan in TX has dropped below 3 stars — qualifies for Star Rating SEP.`,
        priority: 'normal',
      });
    }

    // NOTE: NO birthday month Medigap alerts for OK or TX
    // Oklahoma: no birthday rule
    // Texas: no birthday rule
  }

  // Sort by priority: high first
  return alerts.sort((a, b) => (a.priority === 'high' ? -1 : 1));
}

// Estimate Part B effective from DOB (first day of birthday month at 65)
function getPartBEffectiveFromDOB(dob) {
  if (!dob) return null;
  try {
    const birthDate = new Date(dob);
    const partBDate = new Date(birthDate);
    partBDate.setFullYear(birthDate.getFullYear() + 65);
    partBDate.setDate(1); // First of birthday month
    return partBDate;
  } catch {
    return null;
  }
}

module.exports = { checkEligibilityWindows };
