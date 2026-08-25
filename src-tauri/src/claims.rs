//! Claiming a copy somebody installed by hand.
//!
//! The logic lives in `burrow_core::claim`, which knows nothing about Tauri
//! and is where the tests are. This is the command surface: it walks the
//! destinations this machine actually has, hands each one to the scan, and
//! turns the user's choice into a ledger entry.
//!
//! Nothing here writes, moves or deletes a payload. A claim changes exactly
//! one file — `ledger.json` — and releasing a claim changes it back. What it
//! *does* do is make Burrow willing to replace and delete those files later,
//! which is why the scan offers only what the catalogue can identify, and why
//! the UI shows the name and the path before anything is recorded.

use burrow_core::claim::{self, Candidate, IdentifierIndex};
use burrow_core::dest::Destination;
use burrow_core::model::Format;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::state::{self, AppState};

/// One claimable payload, with the destination it was found in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Claimable {
    #[serde(flatten)]
    pub candidate: Candidate,
    /// The project's display name, so the UI does not have to join back to the
    /// catalogue to render a row.
    pub name_of_project: String,
    pub format: Format,
    pub destination_id: String,
    pub destination_label: String,
    /// Abbreviated, because this is read by a person and a real path carries
    /// the account name — the same rule as everywhere else in the UI.
    pub destination_display_path: String,
    /// Another payload of the same project is in the same folder, and the
    /// ledger has room for one. Claiming both is refused, so the row says so
    /// before the user picks rather than after.
    pub contested: bool,
}

/// A ledger entry the user adopted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedEntry {
    pub slug: String,
    pub name_of_project: String,
    pub format: Format,
    pub destination_id: String,
    pub destination_label: String,
    pub names: Vec<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    pub slug: String,
    pub format: Format,
    pub destination_id: String,
    /// The exact top-level names to record. Never a pattern, and every one of
    /// them must exist or the claim is refused whole.
    pub names: Vec<String>,
    /// What the payload says its version is, when it says anything.
    pub version: Option<String>,
}

fn index(state: &AppState) -> Result<IdentifierIndex, String> {
    let catalog = state.catalog.lock().map_err(|_| "state is poisoned")?;
    let Some(cat) = catalog.as_ref() else {
        return Ok(IdentifierIndex::default());
    };
    Ok(IdentifierIndex::build(
        cat.entries.iter().map(|e| (e.slug.as_str(), e.identifiers.as_slice())),
    ))
}

/// Everything on this machine that Burrow could adopt but has not.
///
/// A catalogue with no identifiers in it cannot recognise anything, and that
/// is **not** the same answer as "there is nothing here to claim" — an empty
/// list would tell the user their machine is fully managed when in fact this
/// build cannot see. Every catalogue written before identifiers existed is in
/// that state, and a cached or baked copy can be one for a long time, so it is
/// reported rather than flattened into a quiet empty list.
#[tauri::command]
pub fn scan_claimable(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<Claimable>, String> {
    let idx = index(&state)?;
    if idx.is_empty() {
        return Err("the plugin list Burrow has does not say what each project's \
                    bundles are called, so nothing here can be recognised. Check for \
                    updates to fetch a newer one."
            .into());
    }
    let env = state::get_environment(app, state.clone())?;
    let names: Vec<(String, String)> = {
        let cat = state.catalog.lock().map_err(|_| "state is poisoned")?;
        cat.as_ref()
            .map(|c| c.entries.iter().map(|e| (e.slug.clone(), e.name.clone())).collect())
            .unwrap_or_default()
    };
    let ledger = state.ledger.lock().map_err(|_| "state is poisoned")?;

    let mut out = Vec::new();
    for d in &env.destinations {
        if !d.exists {
            continue;
        }
        // What this destination already accounts for. Passed in so the scan
        // stays free of the ledger's shape.
        let already: Vec<String> = ledger
            .entries
            .iter()
            .filter(|e| e.destination_id == d.id)
            .flat_map(|e| e.entries.clone())
            .collect();
        let found = claim::scan(&d.path, &idx, &already);
        let contested: Vec<String> =
            claim::contested(&found).into_iter().map(|(slug, _)| slug).collect();
        for c in found {
            let name_of_project = names
                .iter()
                .find(|(slug, _)| *slug == c.slug)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| c.slug.clone());
            out.push(Claimable {
                contested: contested.contains(&c.slug),
                candidate: c,
                name_of_project,
                format: d.format,
                destination_id: d.id.clone(),
                destination_label: d.label.clone(),
                destination_display_path: d.display_path.clone(),
            });
        }
    }
    Ok(out)
}

/// What the user has adopted, so the UI can offer to hand it back.
///
/// The only place `LedgerEntry::claimed` is read. Nothing about installing,
/// updating or removing a payload consults it — a claimed entry behaves
/// exactly like one Burrow installed.
#[tauri::command]
pub fn list_claimed(state: State<'_, AppState>) -> Result<Vec<ClaimedEntry>, String> {
    let names: Vec<(String, String)> = {
        let cat = state.catalog.lock().map_err(|_| "state is poisoned")?;
        cat.as_ref()
            .map(|c| c.entries.iter().map(|e| (e.slug.clone(), e.name.clone())).collect())
            .unwrap_or_default()
    };
    let ledger = state.ledger.lock().map_err(|_| "state is poisoned")?;
    Ok(ledger
        .entries
        .iter()
        .filter(|e| e.claimed)
        .map(|e| ClaimedEntry {
            slug: e.slug.clone(),
            name_of_project: names
                .iter()
                .find(|(s, _)| *s == e.slug)
                .map(|(_, n)| n.clone())
                .unwrap_or_else(|| e.slug.clone()),
            format: e.format,
            destination_id: e.destination_id.clone(),
            destination_label: e.destination_id.clone(),
            names: e.entries.clone(),
            // Empty is how the ledger spells "no readable version"; the UI
            // shows nothing rather than an empty string in a version slot.
            version: (!e.version.is_empty()).then(|| e.version.clone()),
        })
        .collect())
}

/// Adopt a payload: record it in the ledger exactly as an install would.
///
/// Returns the refreshed plugin list, so the row the user was looking at
/// changes under them rather than after a manual rescan.
#[tauri::command]
pub fn claim(
    app: AppHandle,
    state: State<'_, AppState>,
    request: ClaimRequest,
) -> Result<Vec<state::PluginView>, String> {
    let env = state::get_environment(app.clone(), state.clone())?;
    let dest: &Destination = env
        .destinations
        .iter()
        .find(|d| d.id == request.destination_id)
        .ok_or_else(|| format!("no destination called {}", request.destination_id))?;

    // The format has to be the destination's own. A request naming a format
    // that does not belong there would write a ledger entry reconciliation can
    // never match, and the row would stay stuck on "not installed" with no
    // explanation.
    if dest.format != request.format {
        return Err(format!(
            "{} holds {} payloads, not {}",
            dest.label,
            dest.format.label(),
            request.format.label()
        ));
    }

    // ⚠️ One project can have two bundles in one folder, and the ledger cannot
    // hold both: it keys on (slug, format, destination). Real cases on the
    // author's own machine — flock ships `flock.app` *and* `flock Launcher.app`,
    // RFutils and SRT Router the same, and LEQtion has a stable and a NEXT beta
    // side by side under one identifier.
    //
    // Claiming the second would `upsert` over the first and orphan it: Burrow
    // would stop knowing about a file it had been told it owns, which is the
    // exact state the ledger exists to prevent. So the second claim is refused
    // and says what holds the slot, rather than merging them — merging would
    // make one uninstall delete both, and for LEQtion those are two different
    // versions somebody chose to keep.
    {
        let ledger = state.ledger.lock().map_err(|_| "state is poisoned")?;
        if let Some(existing) = ledger.key(&request.slug, request.format, &request.destination_id) {
            return Err(format!(
                "Burrow already manages {} here as this project. It can only track one \
                 {} payload per folder, so claiming this as well would make it forget \
                 that one — release it first if this is the copy you want managed.",
                existing.entries.join(", "),
                request.format.label(),
            ));
        }
    }

    let now = crate::jobs::now_stamp();
    let entry = claim::entry_for(
        &request.slug,
        request.format,
        &request.destination_id,
        &dest.path,
        &request.names,
        request.version.as_deref(),
        &now,
    )?;

    {
        let mut ledger = state.ledger.lock().map_err(|_| "state is poisoned")?;
        ledger.upsert(entry);
    }
    state::save_ledger(&state)?;
    state::list_plugins(app, state)
}

/// Forget a claim. Deletes nothing — the payload stays exactly where it is.
///
/// The same command releases an entry Burrow installed, and that is deliberate
/// rather than an oversight: "stop managing this, leave it alone" is a
/// reasonable thing to want about anything in the ledger, and it is the only
/// non-destructive way out of a wrong claim.
#[tauri::command]
pub fn release(
    app: AppHandle,
    state: State<'_, AppState>,
    slug: String,
    format: Format,
    destination_id: String,
) -> Result<Vec<state::PluginView>, String> {
    {
        let mut ledger = state.ledger.lock().map_err(|_| "state is poisoned")?;
        ledger.remove(&slug, format, &destination_id);
    }
    state::save_ledger(&state)?;
    state::list_plugins(app, state)
}

#[cfg(test)]
mod tests {

    #[test]
    fn a_claim_is_stamped_the_same_way_an_install_is() {
        // Same helper, deliberately: two timestamp formats in one ledger would
        // be a puzzle for whoever reads the file next.
        let t = crate::jobs::now_stamp();
        assert!(t.starts_with("epoch:"));
        assert!(t["epoch:".len()..].parse::<u64>().unwrap() > 1_700_000_000);
    }
}
