// Built-in English + Bangla dictionary.
// We do not use chrome.i18n / _locales, because the language must be
// switchable at runtime from Settings. Every user-visible string lives here.

export const LANGUAGES = ['en', 'bn'];

const STRINGS = {
  en: {
    appName: 'GetSmart DM',
    tagline: 'Download Smarter. Faster. Better.',

    // Popup
    tabDownloads: 'Downloads',
    tabThisPage: 'This page',
    openSettings: 'Settings',
    emptyDownloadsTitle: 'No downloads yet',
    emptyDownloadsBody: 'Files you download in this browser will show up here.',
    emptyPageTitle: 'Nothing found on this page',
    emptyPageBody: 'Videos and audio files this page plays will be listed here.',

    // Downloads tab (M2)
    searchDownloads: 'Search downloads',
    clearFinished: 'Clear finished',
    noMatchTitle: 'No downloads match',
    noMatchBody: 'Try another search or category.',
    catAll: 'All',
    catVideo: 'Video',
    catMusic: 'Music',
    catDocuments: 'Documents',
    catPrograms: 'Programs',
    catArchives: 'Archives',
    catImages: 'Images',
    catOther: 'Other',
    stateDownloading: 'Downloading',
    statePaused: 'Paused',
    stateComplete: 'Completed',
    stateCancelled: 'Cancelled',
    stateFailed: 'Failed',
    stateDeleted: 'File deleted',
    errNetwork: 'Network error',
    errServer: 'Server error',
    errDiskFull: 'Disk full',
    errAccess: 'Access denied',
    errTooLarge: 'File too large',
    errBlocked: 'Blocked',
    errCrash: 'Browser closed',
    sizeOf: '{done} of {total}',
    speedPerSecond: '{size}/s',
    timeLeft: '{time} left',
    actPause: 'Pause',
    actResume: 'Resume',
    actCancel: 'Cancel',
    actRetry: 'Retry',
    actOpen: 'Open file',
    actShow: 'Show in folder',
    actCopyLink: 'Copy link',
    actRemove: 'Remove from list',
    linkCopied: 'Link copied',
    actionFailed: 'That did not work: {error}',
    stateQueued: 'Waiting in queue',

    // Notifications (M3)
    notifDoneTitle: 'Download complete',
    notifFailedTitle: 'Download failed',
    notifCannotSaveTitle: 'This cannot be saved',
    notifBlobBody: 'The page made this file inside the browser (a blob: or data: address), so there is no link to download. Use the page\'s own save button instead.',
    notifNotHttpBody: 'GetSmart DM can only download http:// and https:// links.',

    // Context menus (M4)
    menuDownloadLink: 'Download link with GetSmart DM',
    menuDownloadMedia: 'Download this file with GetSmart DM',
    menuGrabLinks: 'Grab all links on this page',

    // Add links panel (M4)
    addLinks: 'Add links',
    addLinksHint: 'One link per line. Only http:// and https:// links are added.',
    addLinksPlaceholder: 'https://example.com/file.zip',
    addButton: 'Add',
    cancelButton: 'Cancel',
    addedLinks: 'Added {count} to the queue',
    skippedLines: '{count} skipped (not http/https)',
    nothingToAdd: 'Paste at least one http:// or https:// link.',

    // Link grabber (M5)
    grabberTitle: 'Link grabber',
    grabRescan: 'Scan again',
    grabFilter: 'Filter by name or address',
    grabDownloadSelected: 'Download selected',
    grabSelectAll: 'Select all shown',
    grabColName: 'Name',
    grabColType: 'Type',
    grabColAddress: 'Address',
    grabCount: '{selected} selected of {shown} shown',
    grabTabClosedTitle: 'The tab is gone',
    grabTabClosedBody: 'The page this list came from was closed. Open it again and use "Grab all links on this page".',
    grabForbiddenTitle: 'Chrome does not allow this page',
    grabForbiddenBody: 'Browser pages (chrome://, edge://), the extension stores and some protected pages cannot be read by extensions.',
    grabNoLinksTitle: 'No links found',
    grabNoLinksBody: 'This page has no http or https links, images or media. If it is still loading, wait and press "Scan again".',

    // Options
    settingsTitle: 'Settings',
    sectionAppearance: 'Appearance',
    language: 'Language',
    languageHint: 'Language used by the popup and this page.',
    langAuto: 'Automatic (browser language)',
    langEn: 'English',
    langBn: 'বাংলা (Bangla)',
    theme: 'Theme',
    themeHint: 'Automatic follows your system setting.',
    themeAuto: 'Automatic',
    themeLight: 'Light',
    themeDark: 'Dark',
    sectionAbout: 'About',
    version: 'Version',
    extensionId: 'Extension ID',
    saved: 'Saved',
    moreSettingsSoon: 'More settings arrive in later versions.',

    // Popup footer (update-check.js)
    updateAvailable: 'Update available',
  },

  bn: {
    appName: 'GetSmart DM',
    tagline: 'আরও স্মার্ট, আরও দ্রুত, আরও ভালো ডাউনলোড।',

    tabDownloads: 'ডাউনলোড',
    tabThisPage: 'এই পেজ',
    openSettings: 'সেটিংস',
    emptyDownloadsTitle: 'এখনও কোনো ডাউনলোড নেই',
    emptyDownloadsBody: 'এই ব্রাউজারে যা ডাউনলোড করবেন, তা এখানে দেখা যাবে।',
    emptyPageTitle: 'এই পেজে কিছু পাওয়া যায়নি',
    emptyPageBody: 'এই পেজ যে ভিডিও ও অডিও চালায়, সেগুলো এখানে দেখানো হবে।',

    searchDownloads: 'ডাউনলোড খুঁজুন',
    clearFinished: 'শেষ হওয়াগুলো সরান',
    noMatchTitle: 'মিলে যায় এমন কোনো ডাউনলোড নেই',
    noMatchBody: 'অন্য কিছু লিখে বা অন্য ধরন বেছে দেখুন।',
    catAll: 'সব',
    catVideo: 'ভিডিও',
    catMusic: 'গান',
    catDocuments: 'ডকুমেন্ট',
    catPrograms: 'প্রোগ্রাম',
    catArchives: 'আর্কাইভ',
    catImages: 'ছবি',
    catOther: 'অন্যান্য',
    stateDownloading: 'ডাউনলোড হচ্ছে',
    statePaused: 'থামানো আছে',
    stateComplete: 'সম্পূর্ণ',
    stateCancelled: 'বাতিল',
    stateFailed: 'ব্যর্থ',
    stateDeleted: 'ফাইল মুছে ফেলা হয়েছে',
    errNetwork: 'নেটওয়ার্ক সমস্যা',
    errServer: 'সার্ভার সমস্যা',
    errDiskFull: 'ডিস্কে জায়গা নেই',
    errAccess: 'অনুমতি নেই',
    errTooLarge: 'ফাইল খুব বড়',
    errBlocked: 'আটকানো হয়েছে',
    errCrash: 'ব্রাউজার বন্ধ হয়ে গিয়েছিল',
    sizeOf: '{total} এর {done}',
    speedPerSecond: '{size}/সে',
    timeLeft: 'বাকি {time}',
    actPause: 'থামান',
    actResume: 'আবার চালু করুন',
    actCancel: 'বাতিল করুন',
    actRetry: 'আবার চেষ্টা করুন',
    actOpen: 'ফাইল খুলুন',
    actShow: 'ফোল্ডারে দেখান',
    actCopyLink: 'লিংক কপি করুন',
    actRemove: 'তালিকা থেকে সরান',
    linkCopied: 'লিংক কপি হয়েছে',
    actionFailed: 'কাজটি হয়নি: {error}',
    stateQueued: 'সারিতে অপেক্ষা করছে',

    notifDoneTitle: 'ডাউনলোড সম্পূর্ণ',
    notifFailedTitle: 'ডাউনলোড ব্যর্থ',
    notifCannotSaveTitle: 'এটি সংরক্ষণ করা যাবে না',
    notifBlobBody: 'পেজটি ফাইলটি ব্রাউজারের ভেতরেই তৈরি করেছে (blob: বা data: ঠিকানা), তাই ডাউনলোডের কোনো লিংক নেই। পেজের নিজস্ব সেভ বাটন ব্যবহার করুন।',
    notifNotHttpBody: 'GetSmart DM শুধু http:// ও https:// লিংক ডাউনলোড করতে পারে।',

    menuDownloadLink: 'GetSmart DM দিয়ে লিংক ডাউনলোড করুন',
    menuDownloadMedia: 'GetSmart DM দিয়ে এই ফাইল ডাউনলোড করুন',
    menuGrabLinks: 'এই পেজের সব লিংক সংগ্রহ করুন',

    addLinks: 'লিংক যোগ করুন',
    addLinksHint: 'প্রতি লাইনে একটি লিংক। শুধু http:// ও https:// লিংক যোগ হবে।',
    addLinksPlaceholder: 'https://example.com/file.zip',
    addButton: 'যোগ করুন',
    cancelButton: 'বাতিল',
    addedLinks: 'সারিতে {count}টি যোগ হয়েছে',
    skippedLines: '{count}টি বাদ পড়েছে (http/https নয়)',
    nothingToAdd: 'অন্তত একটি http:// বা https:// লিংক দিন।',

    grabberTitle: 'লিংক সংগ্রাহক',
    grabRescan: 'আবার খুঁজুন',
    grabFilter: 'নাম বা ঠিকানা দিয়ে ছাঁকুন',
    grabDownloadSelected: 'বাছাইগুলো ডাউনলোড করুন',
    grabSelectAll: 'দেখানো সব বাছুন',
    grabColName: 'নাম',
    grabColType: 'ধরন',
    grabColAddress: 'ঠিকানা',
    grabCount: '{shown}টির মধ্যে {selected}টি বাছাই করা',
    grabTabClosedTitle: 'ট্যাবটি আর নেই',
    grabTabClosedBody: 'যে পেজ থেকে এই তালিকা এসেছিল সেটি বন্ধ হয়ে গেছে। পেজটি আবার খুলে "এই পেজের সব লিংক সংগ্রহ করুন" ব্যবহার করুন।',
    grabForbiddenTitle: 'Chrome এই পেজে অনুমতি দেয় না',
    grabForbiddenBody: 'ব্রাউজারের নিজস্ব পেজ (chrome://, edge://), এক্সটেনশন স্টোর এবং কিছু সুরক্ষিত পেজ এক্সটেনশন পড়তে পারে না।',
    grabNoLinksTitle: 'কোনো লিংক পাওয়া যায়নি',
    grabNoLinksBody: 'এই পেজে কোনো http বা https লিংক, ছবি বা মিডিয়া নেই। পেজ এখনও লোড হলে একটু অপেক্ষা করে "আবার খুঁজুন" চাপুন।',

    settingsTitle: 'সেটিংস',
    sectionAppearance: 'চেহারা',
    language: 'ভাষা',
    languageHint: 'পপআপ ও এই পেজে যে ভাষা ব্যবহার হবে।',
    langAuto: 'স্বয়ংক্রিয় (ব্রাউজারের ভাষা)',
    langEn: 'English (ইংরেজি)',
    langBn: 'বাংলা',
    theme: 'থিম',
    themeHint: 'স্বয়ংক্রিয় থিম আপনার সিস্টেমের সেটিং অনুসরণ করে।',
    themeAuto: 'স্বয়ংক্রিয়',
    themeLight: 'লাইট',
    themeDark: 'ডার্ক',
    sectionAbout: 'পরিচিতি',
    version: 'সংস্করণ',
    extensionId: 'এক্সটেনশন আইডি',
    saved: 'সংরক্ষিত',
    moreSettingsSoon: 'আরও সেটিংস পরের সংস্করণগুলোতে আসবে।',

    updateAvailable: 'আপডেট পাওয়া যাচ্ছে',
  },
};

let current = 'en';

/** Resolve a setting value ("auto" | "en" | "bn") to a concrete language. */
export function resolveLanguage(setting) {
  if (LANGUAGES.includes(setting)) return setting;
  const browser = (globalThis.navigator?.language || 'en').toLowerCase();
  return browser.startsWith('bn') ? 'bn' : 'en';
}

export function setLanguage(setting) {
  current = resolveLanguage(setting);
  return current;
}

export function getLanguage() {
  return current;
}

/**
 * Translate a key. `{name}` placeholders are filled from `vars`.
 * Falls back to English, then to the key itself, so a missing string is visible
 * but never breaks the UI.
 */
export function t(key, vars = {}) {
  const text = STRINGS[current]?.[key] ?? STRINGS.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

/**
 * Fill every element in `root` that carries data-i18n (text content),
 * data-i18n-title (title attribute) or data-i18n-placeholder.
 */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  if (root === document) {
    document.documentElement.lang = current;
  }
}

/** Exposed for tests: every language must define the same keys as English. */
export function missingKeys() {
  const base = Object.keys(STRINGS.en);
  return Object.fromEntries(
    LANGUAGES.map((lang) => [lang, base.filter((k) => !(k in STRINGS[lang]))])
  );
}
