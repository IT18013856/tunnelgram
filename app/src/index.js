import './Services/XMLHttpRequestWrapper';
import './setup/icons';
import './setup/pnotify';
import {Nymph, PubSub} from 'nymph-client';
import {User, Group} from 'tilmeld-client';
import {router} from './Services/router';
import './Services/OfflineServerCallsService';
import {cache} from './Services/EntityCacheService';
import {crypt} from './Services/EncryptionService';
import {storage} from './Services/StorageService';
import {urlBase64ToUint8Array} from './Services/urlBase64';
import {VideoService} from './Services/VideoService';
import Conversation from './Entities/Tunnelgram/Conversation';
import Message from './Entities/Tunnelgram/Message';
import AppPushSubscription from './Entities/Tunnelgram/AppPushSubscription';
import WebPushSubscription from './Entities/Tunnelgram/WebPushSubscription';
import Readline from './Entities/Tunnelgram/Readline';
import Settings from './Entities/Tunnelgram/Settings';
import Container from './Container.html';
import ErrHandler from './ErrHandler';

import {get} from 'svelte/store';
import * as store from './stores';

import './scss/styles.scss';

// Register the ServiceWorker.
let swRegPromise = Promise.resolve(null);
if ('serviceWorker' in navigator) {
  if (navigator.serviceWorker.controller) {
    swRegPromise = navigator.serviceWorker.getRegistration('/');
    swRegPromise.then(reg => {
      console.log('Service worker has been retrieved for scope: '+ reg.scope);
    });
  } else {
    swRegPromise = navigator.serviceWorker.register('/ServiceWorker.js', {
      scope: '/'
    });
    swRegPromise.then(reg => {
      console.log('Service worker has been registered for scope: '+ reg.scope);
    });
  }
}

// This stores the function to set up the Web Push Notification subscription.
let setupSubscription;

export function refreshAll () {
  cache.clear();

  const settings = get(store.settings);
  if (settings != null) {
    settings.init(settings.toJSON());
  }

  const conversation = get(store.conversation);
  if (conversation.guid) {
    const newConv = new Conversation();
    newConv.init(conversation.toJSON());
    store.conversation.set(new Conversation());
    store.conversation.set(newConv);
  }

  const conversations = get(store.conversations);
  for (let i in conversations) {
    const newConv = new Conversation();
    newConv.init(conversations[i].toJSON());
    conversations[i] = newConv;
  }
  store.conversations.set(conversations);
};

window.addEventListener('beforeinstallprompt', e => {
  // Prevent Chrome 67 and earlier from automatically showing the prompt
  e.preventDefault();
  // Stash the event so it can be triggered later.
  store.beforeInstallPromptEvent.set(e);
});

PubSub.on('connect', () => store.disconnected.set(false));
PubSub.on('disconnect', () => store.disconnected.set(true));

// Everything is this function requires the logged in user status to be known.
(async () => {
  await store.userReadyPromise;

  store.conversation.subscribe(conversation => {
    if (conversation && conversation.guid) {
      const conversations = get(store.conversations);
      // Refresh conversations' readlines when current conversation changes.
      for (let curConv of conversations) {
        if (curConv != null && conversation != null && conversation === curConv) {
          // They are the same instance, so mark conversations as changed.
          store.conversations.set(conversations);
          break;
          // If they are the same entity, but different instances, the next code
          // block will update conversations.
        }
      }
    }
  });

  function syncConversations(conversation, conversations) {
    // 'conversation' and the corresponding entity in 'conversations' should be
    // the same instance, so check to make sure they are.
    if (conversation && conversation.guid) {
      const idx = conversation.arraySearch(conversations);

      if (idx !== false && conversation !== conversations[idx]) {
        // Check both of their modified dates. Whichever is most recent wins.
        if (conversations[idx].mdate > conversation.mdate) {
          conversation = conversations[idx];
          store.conversation.set(conversation);
        } else {
          conversations[idx] = conversation;
          store.conversations.set(conversations);
        }
      }
    }
  }
  store.conversation.subscribe(conversation => syncConversations(conversation, get(store.conversations)));
  store.conversations.subscribe(conversations => syncConversations(get(store.conversation), conversations));

  store.conversations.subscribe(conversations => {
    if (conversations.length === 0) {
      router.navigate('/c');
    }
  });

  let previousUser = get(store.user);
  store.user.subscribe(user => {
    if (user) {
      const route = router.lastRouteResolved();
      if (route) {
        const queryMatch = route.query.match(/(?:^|&)continue=([^&]+)(?:&|$)/);
        if (queryMatch) {
          router.navigate(decodeURIComponent(queryMatch[1]));
        }
      }

      if (setupSubscription) {
        setupSubscription();
      }

      // If the user logs in, get their settings.
      if (get(store.settings) == null || !user.is(previousUser)) {
        crypt.ready.then(() => {
          Settings.current().then(settings => {
            store.settings.set(settings);
          });
        });
      }
    } else if (user === null) {
      // If the user logs out, clear everything.
      storage.clear();
      store.user.set(null);
      store.conversations.set([]);
      store.conversation.set(new Conversation());
      store.settings.set(null);
      refreshAll();
      // And navigate to the home screen.
      router.navigate('/');
    }

    previousUser = user;
  });

  if (get(store.user) != null) {
    // Get the current settings.
    crypt.ready.then(() => {
      Settings.current().then(settings => {
        store.settings.set(settings);
      });
    });
  }

  (async () => {
    if (window.inCordova) {
      // Cordova OneSignal Push Subscriptions

      // When user consents to notifications, tell OneSignal.
      store.requestNotificationPermission.set(() => window.plugins.OneSignal.provideUserConsent(true));

      // This won't resolve until the user allows notifications and OneSignal
      // registers the device and returns a player ID. This should only happen
      // after the user has logged in, so we can safely save it to the server.
      let playerId = await window.appPushPlayerIdPromise;
      if (playerId == null) {
        return;
      }

      // Push the playerId up to the server. (It will be updated if it already
      // exists.)
      const appPushSubscription = new AppPushSubscription();
      appPushSubscription.set({
        playerId
      });
      appPushSubscription.save().catch(ErrHandler);
    } else {
      // Web Push Subscriptions
      if ((await swRegPromise) == null) {
        return;
      }

      // Support for push, notifications, and push payloads.
      const pushSupport = 'PushManager' in window;
      const notificationSupport = 'showNotification' in ServiceWorkerRegistration.prototype;
      // Maybe I'll use these if I can figure out how to get payloads to work.
      // const payloadSupport = 'getKey' in PushSubscription.prototype;
      // const aesgcmSupport = PushManager.supportedContentEncodings.indexOf('aesgcm') > -1;

      if (pushSupport && notificationSupport) {
        setupSubscription = async () => {
          const getSubscription = () => {
            return navigator.serviceWorker.ready.then(registration => {
              return registration.pushManager.getSubscription();
            });
          };

          const subscribeFromWorker = subscriptionOptions => {
            return new Promise((resolve, reject) => {
              if (!navigator.serviceWorker.controller) {
                reject(new Error('There is no service worker.'));
                return;
              }

              navigator.serviceWorker.controller.postMessage({
                command: 'subscribe',
                subscriptionOptions: subscriptionOptions
              });

              const messageListenerFunction = event => {
                navigator.serviceWorker.removeEventListener('message', messageListenerFunction);
                switch (event.data.command) {
                  case 'subscribe-success':
                    resolve(getSubscription());
                    break;
                  case 'subscribe-failure':
                    reject(new Error('Subscription failed: ' + event.data.message));
                    break;
                  default:
                    reject(new Error('Invalid command: ' + event.data.command));
                    break;
                }
              };

              navigator.serviceWorker.addEventListener('message', messageListenerFunction);
            });
          };


          // See if there is a subscription already.
          let subscription = await getSubscription();

          if (subscription) {
            store.webPushSubscription.set(subscription);

            try {
              const webPushSubscriptionServerCheck = await Nymph.getEntity({
                class: WebPushSubscription.class
              }, {
                'type': '&',
                'strict': ['endpoint', subscription.endpoint]
              });

              if (webPushSubscriptionServerCheck != null) {
                return;
              }
            } catch (e) {
              if (e.status !== 404) {
                throw e;
              }
            }
          } else {
            // The vapid key from the server.
            const vapidPublicKey = await WebPushSubscription.getVapidPublicKey();
            if (!vapidPublicKey) {
              return;
            }
            const convertedVapidKey = Array.from(urlBase64ToUint8Array(vapidPublicKey));

            // Make the subscription.
            subscription = await subscribeFromWorker({
              userVisibleOnly: true,
              applicationServerKey: convertedVapidKey
            });

            store.webPushSubscription.set(subscription);
          }

          // And push it up to the server.
          const webPushSubscription = new WebPushSubscription();
          const subscriptionData = JSON.parse(JSON.stringify(subscription));
          webPushSubscription.set({
            endpoint: subscriptionData.endpoint,
            keys: {
              p256dh: subscriptionData.keys.p256dh,
              auth: subscriptionData.keys.auth
            }
          });
          webPushSubscription.save().catch(ErrHandler);
        };

        // Set notification permission asker.
        store.requestNotificationPermission.set(async () => {
          const permissionResult = await new Promise(async resolve => {
            const promise = Notification.requestPermission(value => resolve(value));
            if (promise) {
              resolve(await promise);
            }
          });

          if (permissionResult === 'denied' || permissionResult === 'default') {
            return;
          }

          setupSubscription();
        });

        if (Notification.permission === 'granted') {
          if (get(store.user)) {
            setupSubscription();
          }
        }
      }
    }
  })();

  const loader = document.getElementById('initialLoader');
  if (loader) {
    loader.parentNode.removeChild(loader);
  }

  const app = new Container({
    target: document.querySelector('main'),
    props: {},
    store
  });

  const conversationHandler = params => {
    const guid = parseFloat(params.id);
    const conversations = get(store.conversations);
    let conversation = null;
    for (let cur of conversations) {
      if (cur.guid === guid) {
        conversation = cur;
        break;
      }
    }
    store.loadingConversation.set(true);
    if (conversation) {
      store.conversation.set(conversation);
      store.view.set(params.view || 'conversation');
      store.convosOut.set(false);
      store.loadingConversation.set(false);
    } else {
      crypt.ready.then(() => {
        Nymph.getEntity({
          'class': Conversation.class
        }, {
          'type': '&',
          'guid': guid
        }).then(conversation => {
          store.conversation.set(conversation);
          store.view.set(params.view || 'conversation');
          store.convosOut.set(false);
          store.loadingConversation.set(false);
        }, err => {
          ErrHandler(err);
          store.loadingConversation.set(false);
          router.navigate('/');
        });
      });
    }
  };

  const userHandler = params => {
    const {username} = params;
    const user = get(store.user);
    store.loadingUser.set(true);
    if (user.data.username === username) {
      store.viewUser.set(user);
      store.viewUserIsSelf.set(true);
      store.view.set('user');
      store.convosOut.set(false);
      store.loadingUser.set(false);
    } else {
      crypt.ready.then(() => {
        User.byUsername(username).then(viewUser => {
          store.viewUser.set(viewUser);
          store.viewUserIsSelf.set(false);
          store.view.set('user');
          store.convosOut.set(false);
          store.loadingUser.set(false);
        }, err => {
          ErrHandler(err);
          store.loadingUser.set(false);
          router.navigate('/');
        });
      });
    }
  };

  let forwardCount = 0;
  router.hooks({
    before: (done, params) => {
      if (!get(store.user)) {
        const route = router.lastRouteResolved();
        if (route && route.url !== '/' && route.url !== '') {
          forwardCount++;
          if (forwardCount > 15) {
            debugger;
          }
          const url = route.url + (route.query !== '' ? '?'+route.query : '');
          router.navigate('/?continue='+encodeURIComponent(url));
        }
        done(false);
      } else {
        done();
      }
    }
  });

  router.on(() => {
    store.convosOut.set(true);
  }).on({
    'c/:id': {uses: conversationHandler},
    'c/:id/:view': {uses: conversationHandler},
    'c': () => {
      const conversation = new Conversation();
      store.conversation.set(conversation);
      store.view.set('conversation');
      store.convosOut.set(false);
    },
    'u/:username': {uses: userHandler},
    'pushSubscriptions': () => {
      store.view.set('pushSubscriptions');
      store.convosOut.set(false);
      store.loadingConversation.set(false);
      store.loadingUser.set(false);
    },
    'pwa-home': () => {
      store.convosOut.set(true);
    }
  }).notFound(() => {
    router.navigate('/');
  }).resolve();
})();

// Required for Cordova.
window.router = router;
// Useful for debugging.
window.store = store;
window.Nymph = Nymph;
window.User = User;
window.Group = Group;
window.Conversation = Conversation;
window.Message = Message;
window.AppPushSubscription = AppPushSubscription;
window.WebPushSubscription = WebPushSubscription;
window.Readline = Readline;
window.Settings = Settings;
window.VideoService = VideoService;
window.storage = storage;
window.cache = cache;
window.refreshAll = refreshAll;
