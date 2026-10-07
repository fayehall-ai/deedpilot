// The toolbar button opens the results page; it does the USTLA work itself.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("results.html") });
});
