const PRIMARY_KEY = "strforge.state.v2";
const BACKUP_KEY = "strforge.state.v2.backup";

function isValidState(value) {
    if (!value || typeof value !== "string") return false;
    try {
        const state = JSON.parse(value);
        return state && Number.isInteger(state.schemaVersion) &&
            state.schemaVersion >= 1 && state.schemaVersion <= 2;
    } catch {
        return false;
    }
}

export function loadState() {
    try {
        const primary = localStorage.getItem(PRIMARY_KEY);
        if (isValidState(primary)) return primary;

        const backup = localStorage.getItem(BACKUP_KEY);
        if (isValidState(backup)) {
            localStorage.setItem(PRIMARY_KEY, backup);
            return backup;
        }
    } catch (error) {
        console.error("StrForge restore failed", error);
    }
    return null;
}

export function saveState(stateJson) {
    if (!isValidState(stateJson)) throw new Error("Invalid StrForge state.");
    const current = localStorage.getItem(PRIMARY_KEY);
    if (isValidState(current)) localStorage.setItem(BACKUP_KEY, current);
    localStorage.setItem(PRIMARY_KEY, stateJson);
}

export function requestPersistence() {
    try {
        if (navigator.storage?.persist) {
            void navigator.storage.persist().catch(error =>
                console.debug("Persistent storage request was not granted", error));
        }
    } catch (error) {
        console.debug("Persistent storage is unavailable", error);
    }
}
