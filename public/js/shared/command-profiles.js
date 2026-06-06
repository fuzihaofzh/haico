(function() {
  const h = window.h;
  const html = window.html;
  const CUSTOM_PROFILE_VALUE = '__custom__';
  let commandProfiles = [];
  let profilesLoaded = false;
  let profilesLoading = false;
  let loadingPromise = null;
  let loadError = '';

  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
      return;
    }
    fn();
  }

  function dispatchProfilesChanged() {
    window.dispatchEvent(new CustomEvent('haico:command-profiles-changed', {
      detail: commandProfiles.slice(),
    }));
  }

  async function ensureLoaded(force) {
    if (profilesLoading && loadingPromise) return loadingPromise;

    if (profilesLoaded && !force) {
      return commandProfiles;
    }

    profilesLoading = true;
    loadError = '';

    loadingPromise = (async () => {
      try {
        const res = await fetch('/api/command-profiles', { headers: apiHeaders() });
        const data = res.ok ? await res.json() : null;
        if (!res.ok) {
          throw new Error(data?.error || 'Failed to load Agent Tools');
        }
        commandProfiles = Array.isArray(data?.profiles) ? data.profiles.map(normalizeProfile) : [];
        profilesLoaded = true;
        dispatchProfilesChanged();
      } catch (error) {
        console.error('Failed to load Agent Tools', error);
        loadError = error?.message || 'Failed to load Agent Tools';
      } finally {
        profilesLoading = false;
        loadingPromise = null;
      }

      return commandProfiles;
    })();

    return loadingPromise;
  }

  function getProfileById(profileId) {
    return commandProfiles.find((profile) => profile.id === profileId) || null;
  }

  function normalizeValue(value) {
    return String(value || '').trim();
  }

  function normalizeConfigJson(value) {
    if (!value) return {};
    if (typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    }
    return {};
  }

  function normalizeProfile(profile) {
    return {
      ...profile,
      scenario: normalizeValue(profile?.scenario) || null,
      config_json: normalizeConfigJson(profile?.config_json),
    };
  }

  function formatProfileLabel(profile) {
    const scenario = normalizeValue(profile?.scenario);
    return `${profile?.name || 'Agent Tool'}${scenario ? ` · ${scenario}` : ''} (${profile?.type || 'unknown'})`;
  }

  function findMatchingProfile(command, type) {
    const normalizedCommand = normalizeValue(command);
    const normalizedType = normalizeValue(type).toLowerCase();
    if (!normalizedCommand) return null;

    let profile = commandProfiles.find((item) =>
      normalizeValue(item.command) === normalizedCommand && item.type === normalizedType
    );
    if (profile) return profile;

    profile = commandProfiles.find((item) => normalizeValue(item.command) === normalizedCommand);
    return profile || null;
  }

  function populateSelect(select, options) {
    if (!select) return;
    const opts = options || {};
    const includeProjectDefault = opts.includeProjectDefault !== false;
    const includeCustom = opts.includeCustom !== false;
    const projectDefaultLabel = opts.projectDefaultLabel || 'Use project default';
    const customLabel = opts.customLabel || 'Custom command';
    const emptyLabel = opts.emptyLabel || 'No Agent Tools configured. Open Settings to add one.';

    const items = [];
    if (includeProjectDefault) {
      items.push(h`<option value="">${projectDefaultLabel}</option>`);
    }
    if (includeCustom) {
      items.push(h`<option value="${CUSTOM_PROFILE_VALUE}">${customLabel}</option>`);
    }
    commandProfiles.forEach((profile) => {
      items.push(
        h`<option value="${profile.id}">${formatProfileLabel(profile)}</option>`
      );
    });
    if (commandProfiles.length === 0 && !includeProjectDefault && !includeCustom) {
      items.push(h`<option value="" disabled>${emptyLabel}</option>`);
    }
    select.innerHTML = items.join('');
  }

  window.HAICOCommandProfiles = {
    CUSTOM_PROFILE_VALUE,
    ensureLoaded,
    getProfiles: () => commandProfiles.slice(),
    getById: getProfileById,
    findMatch: findMatchingProfile,
    formatLabel: formatProfileLabel,
    populateSelect,
    isLoading: () => profilesLoading,
    getLoadError: () => loadError,
  };

  ready(() => {
    ensureLoaded();
  });
})();
