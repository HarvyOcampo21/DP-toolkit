(function () {
  'use strict';

  const PROCESSED_ATTR = 'data-dp-select-all';

  // Finds every "Download (...)" button on the page and, for each one,
  // injects a Select All / Deselect All toggle plus keyboard navigation
  // for its photo grid.
  function injectSelectAllButtons() {
    const buttons = document.querySelectorAll('button.button');

    buttons.forEach((downloadBtn) => {
      const label = getExactText(downloadBtn);
      if (!/^Download\s*\(\d+\)/.test(label)) return;

      // The checkbox grid and the Download button live in the same
      // ".columns.is-multiline" wrapper (checkboxes are earlier siblings).
      const gridContainer = downloadBtn.closest('.columns.is-multiline');
      if (!gridContainer) return;

      const checkboxes = gridContainer.querySelectorAll('input[type="checkbox"]');
      if (checkboxes.length === 0) return;

      if (!downloadBtn.hasAttribute(PROCESSED_ATTR)) {
        downloadBtn.setAttribute(PROCESSED_ATTR, 'true');
        insertToggleButton(downloadBtn, gridContainer);
      }

      // Re-run every pass (idempotent) so newly loaded photos also
      // become keyboard-navigable.
      setupKeyboardNav(gridContainer);
    });
  }

  function insertToggleButton(downloadBtn, gridContainer) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'button is-small is-light';
    toggleBtn.style.marginRight = '8px';
    toggleBtn.type = 'button';

    updateToggleLabel(toggleBtn, gridContainer.querySelectorAll('input[type="checkbox"]'));

    toggleBtn.addEventListener('click', () => {
      const currentBoxes = gridContainer.querySelectorAll('input[type="checkbox"]');
      const allChecked = Array.from(currentBoxes).every((cb) => cb.checked);

      currentBoxes.forEach((cb) => {
        // Only click boxes that actually need to change state, so we
        // don't accidentally uncheck items when going from a mixed
        // selection to "select all".
        if (allChecked ? cb.checked : !cb.checked) {
          cb.click();
        }
      });

      updateToggleLabel(toggleBtn, currentBoxes);
    });

    // Keep the label ("Select All" vs "Deselect All") in sync if the
    // user manually (un)checks individual photos.
    gridContainer.addEventListener('change', (e) => {
      if (e.target.matches('input[type="checkbox"]')) {
        const currentBoxes = gridContainer.querySelectorAll('input[type="checkbox"]');
        updateToggleLabel(toggleBtn, currentBoxes);
      }
    });

    downloadBtn.parentElement.insertBefore(toggleBtn, downloadBtn);
  }

  // --- Keyboard navigation ---------------------------------------------
  // NOTE: tiles have their own click handler that opens a large preview
  // modal and steals document focus, so real DOM focus/blur can't be used
  // reliably here. Instead we track an "active" tile ourselves via mouse
  // hover (which never opens the preview) and drive navigation off that.

  const NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar'];

  let activeCell = null;
  let activeGrid = null;

  function setupKeyboardNav(gridContainer) {
    getCells(gridContainer).forEach((cell) => {
      if (cell.hasAttribute('data-dp-hoverable')) return;
      cell.setAttribute('data-dp-hoverable', 'true');
      cell.classList.add('dp-select-cell');
      cell.addEventListener('mouseenter', () => setActiveCell(cell, gridContainer));
    });
  }

  function setActiveCell(cell, gridContainer) {
    if (activeCell) activeCell.classList.remove('dp-select-focus');
    activeCell = cell;
    activeGrid = gridContainer;
    activeCell.classList.add('dp-select-focus');
  }

  function handleGridKeydown(e) {
    if (!NAV_KEYS.includes(e.key)) return;
    if (!activeCell || !activeGrid) return;

    // Don't hijack arrow keys / space while typing in a text field
    // (e.g. the Comments box).
    const activeTag = document.activeElement && document.activeElement.tagName;
    if (activeTag === 'TEXTAREA' || (activeTag === 'INPUT' && document.activeElement.type !== 'checkbox')) {
      return;
    }

    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      const cb = activeCell.querySelector('input[type="checkbox"]');
      if (cb) cb.click();
      return;
    }

    const cells = getCells(activeGrid);
    const currentIndex = cells.indexOf(activeCell);
    if (currentIndex === -1) return;

    const columns = getColumnCount(cells);
    let nextIndex = currentIndex;

    if (e.key === 'ArrowRight') nextIndex = Math.min(currentIndex + 1, cells.length - 1);
    else if (e.key === 'ArrowLeft') nextIndex = Math.max(currentIndex - 1, 0);
    else if (e.key === 'ArrowDown') nextIndex = Math.min(currentIndex + columns, cells.length - 1);
    else if (e.key === 'ArrowUp') nextIndex = Math.max(currentIndex - columns, 0);

    e.preventDefault();
    setActiveCell(cells[nextIndex], activeGrid);
    cells[nextIndex].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function getCells(gridContainer) {
    return Array.from(gridContainer.querySelectorAll('input[type="checkbox"]')).map(
      (cb) => cb.closest('.grid-image') || cb.parentElement
    );
  }

  // Determines how many tiles sit in a single row by comparing each
  // cell's vertical position against the first one's, since the CRM's
  // column count can vary with screen width.
  function getColumnCount(cells) {
    if (cells.length < 2) return 1;
    const firstTop = cells[0].getBoundingClientRect().top;
    let count = 0;
    for (const cell of cells) {
      if (Math.abs(cell.getBoundingClientRect().top - firstTop) < 2) {
        count++;
      } else {
        break;
      }
    }
    return count || 1;
  }

  function injectStyles() {
    if (document.getElementById('dp-select-all-style')) return;
    const style = document.createElement('style');
    style.id = 'dp-select-all-style';
    style.textContent = `
      .dp-select-cell { cursor: pointer; }
      .dp-select-focus { outline: 2px solid #3273dc; outline-offset: 2px; border-radius: 4px; }

      /* Blow up the photo preview modal to 90% of the viewport. Uses
         !important because the site sets these dimensions via inline
         styles, which normally beat external stylesheets. */


      /* The row holding the prev/next arrows + image */
      .modal.is-active .modal-card-body > div:first-child {
        flex: 1 1 auto !important;
        min-height: 0 !important;
      }

      /* The image's own wrapper div */
      .modal.is-active .modal-card-body > div:first-child > div {
        min-height: 0 !important;
        height: 100% !important;
      }


      /* The file size / dimensions footer row should keep its natural size */
      .modal.is-active .modal-card-body > div:last-child {
        flex-shrink: 0 !important;
      }
    `;
    document.head.appendChild(style);
  }

  function updateToggleLabel(toggleBtn, checkboxes) {
    const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every((cb) => cb.checked);
    toggleBtn.textContent = allChecked ? 'Deselect All' : 'Select All';
  }

  // Reused pattern from the other DP extensions: trim/normalize text
  // pulled straight off the DOM.
  function getExactText(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const observer = new MutationObserver(() => {
    injectSelectAllButtons();
  });

  observer.observe(document.body, { childList: true, subtree: true });

  // Also catch tab switches / SPA navigation.
  window.addEventListener('hashchange', () => setTimeout(injectSelectAllButtons, 300));

  document.addEventListener('keydown', handleGridKeydown);

  injectStyles();
  injectSelectAllButtons();
})();