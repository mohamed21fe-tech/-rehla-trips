// Minimal, dependency-free JS. Keeps pages fast on slow connections.
(function () {
  // Prevent double-submits on booking / status-change forms.
  document.querySelectorAll('form').forEach(function (form) {
    form.addEventListener('submit', function () {
      var btn = form.querySelector('button[type="submit"]');
      if (btn && !btn.disabled) {
        btn.disabled = true;
        setTimeout(function () { btn.disabled = false; }, 4000);
      }
    });
  });

  // Client-side hint: origin and destination must differ (server re-validates).
  var origin = document.getElementById('origin');
  var destination = document.getElementById('destination');
  if (origin && destination) {
    var check = function () {
      Array.from(destination.options).forEach(function (opt) {
        opt.disabled = !!opt.value && opt.value === origin.value;
      });
    };
    origin.addEventListener('change', check);
    check();
  }
})();
