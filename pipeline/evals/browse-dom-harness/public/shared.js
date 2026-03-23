(function () {
  function setVisible(element, visible) {
    if (!element) return;
    element.hidden = !visible;
    element.classList.toggle("visible", visible);
    element.classList.toggle("hidden", !visible);
  }

  function setState(element, state) {
    if (!element) return;
    element.dataset.state = state;
  }

  function swapState(element, fromState, toState) {
    if (!element || element.dataset.state !== fromState) return false;
    element.dataset.state = toState;
    return true;
  }

  window.sharedHarness = {
    setVisible,
    setState,
    swapState,
  };
})();
