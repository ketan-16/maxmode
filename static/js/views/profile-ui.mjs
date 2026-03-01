import { avatarUrl } from "../modules/storage.mjs";
import { formatDate } from "../modules/data-utils.mjs";

export function renderNavAvatar(user) {
  const img = document.getElementById("nav-avatar");
  if (!img || !user || !user.name) return;
  img.src = avatarUrl(user.name);
}

export function render(state) {
  const nameEl = document.getElementById("profile-name");
  if (!nameEl) return;

  const user = state && state.user ? state.user : null;
  if (!user) return;

  nameEl.textContent = user.name;

  const avatarEl = document.getElementById("profile-avatar");
  if (avatarEl) avatarEl.src = avatarUrl(user.name);

  const sinceEl = document.getElementById("profile-since");
  if (sinceEl) sinceEl.textContent = `Member since ${formatDate(user.createdAt)}`;

  const totalEl = document.getElementById("profile-total-entries");
  if (totalEl) {
    const count = state && Array.isArray(state.weights) ? state.weights.length : 0;
    totalEl.textContent = String(count);
  }
}
