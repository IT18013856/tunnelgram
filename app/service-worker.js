// This is the "Offline copy of pages" service worker

// Install stage sets up the index page (home page) in the cache and opens a new cache
self.addEventListener('install', function (event) {
  var indexPage = new Request('/index.html');
  event.waitUntil(fetch(indexPage).then(function (response) {
    return caches.open('offline-cache').then(function (cache) {
      console.log('[Content Cache] Cached index page during Install '+ response.url);
      return cache.put(indexPage, response);
    });
  }));
});

// If any fetch fails, it will look for the request in the cache and serve it from there first
self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') {
    return;
  }

  var updateCache = function (request){
    return caches.open('offline-cache').then(function (cache) {
      return fetch(request).then(function (response) {
        console.log('[Content Cache] add page to offline '+response.url)
        return cache.put(request, response);
      });
    });
  };

  event.waitUntil(updateCache(event.request));

  event.respondWith(fetch(event.request).catch(function (error) {
    console.log('[Content Cache] Network request Failed. Serving content from cache: ' + error);

    // Check to see if you have it in the cache
    // Return response
    // If not in the cache, then return error page
    return caches.open('offline-cache').then(function (cache) {
      return cache.match(event.request).then(function (matching) {
        var report = !matching || matching.status == 404 ? Promise.reject('no-match') : matching;
        return report;
      });
    });
  }));
});


// Web Push Notifications

// function getEndpoint() {
//   return self.registration.pushManager.getSubscription().then(function (subscription) {
//     if (subscription) {
//       return subscription.endpoint;
//     }
//
//     throw new Error('User not subscribed');
//   });
// }

function isClientFocused () {
  return clients.matchAll({
    type: 'window',
    includeUncontrolled: true
  }).then(function (windowClients) {
    let clientIsFocused = false;

    for (let i = 0; i < windowClients.length; i++) {
      const windowClient = windowClients[i];
      if (windowClient.focused) {
        clientIsFocused = true;
        break;
      }
    }

    return clientIsFocused;
  });
}

function sendNotification (body) {
  const title = 'Tunnelgram';

  return self.registration.showNotification(title, {
    body,
  });
};

self.addEventListener('push', function (event) {
  if (!(self.Notification && self.Notification.permission === 'granted')) {
    return;
  }

  if (event.data) {
    const promiseChain = isClientFocused().then(function (clientIsFocused) {
      if (clientIsFocused) {
        // No need to show a notification.
        return;
      }

      const message = event.data.text();
      return sendNotification(message);
    })
    event.waitUntil(promiseChain);
  }

  // event.waitUntil(getEndpoint().then(function (endpoint) {
  //   return fetch('./getPayload?endpoint=' + endpoint);
  // }).then(function (response) {
  //   return response.text();
  // }).then(function (payload) {
  //   self.registration.showNotification('Tunnelgram', {
  //     body: payload,
  //   });
  // }));
});
