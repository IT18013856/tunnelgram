import {Nymph, Entity} from 'nymph-client';
import {User} from 'tilmeld-client';
import {Message} from './Message';
import {saveEntities, restoreEntities} from '../../Services/entityRefresh';
import {crypt} from '../../Services/EncryptionService';

let currentUser = null;

User.current().then(user => currentUser = user);
User.on('login', user => currentUser = user);
User.on('logout', () => currentUser = null);

export class Conversation extends Entity {
  // === Constructor ===

  constructor (id) {
    super(id);
    this.containsSleepingReference = false;
    this.pending = [];
    this.readline = null;
    this.notifications = Conversation.NOTIFICATIONS_ALL;
    this.unreadCountPromise = null;
    this.unreadCountPromiseReadline = null;
    this.decrypted = {
      name: null
    };
    this.data.name = null;
    this.data.mode = Conversation.MODE_CHAT;
    this.data.acFull = [];
    if (currentUser) {
      this.data.acFull.push(currentUser);
    }
  }

  // === Instance Methods ===

  init (entityData, ...args) {
    const savedEntities = saveEntities(this);

    if (this.readline !== entityData.readline || (this.data.lastMessage && this.data.lastMessage.guid) !== (entityData.data.lastMessage && entityData.data.lastMessage.guid)) {
      this.unreadCountPromise = null;
    }

    super.init(entityData, ...args);
    this.containsSleepingReference = restoreEntities(this, savedEntities);

    if (entityData == null) {
      return this;
    }

    if (entityData.readline != null) {
      this.readline = entityData.readline;
    }

    if (entityData.notifications != null) {
      this.notifications = entityData.notifications;
    }

    // Decrypt the conversation name.
    if (this.data.name != null) {
      let decrypt = input => input;
      if (this.data.mode !== Conversation.MODE_CHANNEL_PUBLIC && currentUser && this.data.keys && currentUser.guid in this.data.keys) {
        const key = crypt.decryptRSA(this.data.keys[currentUser.guid]).slice(0, 96);
        decrypt = input => crypt.decrypt(input, key);
      }

      this.decrypted.name = decrypt(this.data.name);
    }

    return this;
  }

  toJSON () {
    const obj = super.toJSON();

    obj.readline = this.readline;
    obj.notifications = this.notifications;

    return obj;
  }

  async save () {
    if (!this.guid && !currentUser.inArray(this.data.acFull)) {
      this.data.acFull.push(currentUser);
    }

    if (this.data.mode === Conversation.MODE_CHANNEL_PUBLIC) {
      this.data.name = this.decrypted.name;
      delete this.data.keys;
    } else {
      let key;

      if (this.decrypted.name != null || this.data.mode === Conversation.MODE_CHANNEL_PRIVATE) {
        if (this.data.keys && currentUser.guid in this.data.keys) {
          key = crypt.decryptRSA(this.data.keys[currentUser.guid]).slice(0, 96);
        } else {
          this.data.keys = {};
          key = crypt.generateKey();
        }
        const encryptPromises = [];
        // Encrypt the key for conversation users and channel admins.
        for (let user of this.data.acFull) {
          if (!(user.guid in this.data.keys)) {
            const pad = crypt.generatePad();
            encryptPromises.push({guid: user.guid, promise: crypt.encryptRSAForUser(key + pad, user)});
          }
        }
        // This isn't needed because addChannelUser handles channel user keys.
        // if (this.data.mode === Conversation.MODE_CHANNEL_PRIVATE && this.data.group) {
        //   // Encrypt the key for channel users.
        //   if (this.data.group.isASleepingReference) {
        //     await this.data.group.ready();
        //   }
        //   const userGuids = await this.getGroupUserGuids();
        //   for (let guid of userGuids) {
        //     if (!(guid in this.data.keys)) {
        //       const pad = crypt.generatePad();
        //       encryptPromises.push({guid, promise: crypt.encryptRSAForUser(key + pad, guid)});
        //     }
        //   }
        // }
        for (let entry of encryptPromises) {
          this.data.keys[entry.guid] = await entry.promise;
        }
      }

      // Encrypt the conversation name.
      if (this.decrypted.name != null) {
        this.data.name = crypt.encrypt(this.decrypted.name, key);
      } else {
        this.data.name = null;
      }
    }

    return await super.save();
  }

  getName (settings) {
    if (this.guid == null) {
      return 'New '+Conversation.MODE_NAME[this.data.mode];
    } else if (this.decrypted.name != null) {
      return this.decrypted.name;
    } else if (this.data.acFull.length === 1) {
      if (this.data.mode === Conversation.MODE_CHAT) {
        return 'Just You';
      } else if (currentUser.is(this.data.acFull[0])) {
        return 'Your Channel';
      }
    }

    const names = [];
    for (let i = 0; i < this.data.acFull.length; i++) {
      const participant = this.data.acFull[i];
      if (!currentUser.is(participant)) {
        let name = participant.data.name ? participant.data.name : 'Loading...';
        if (settings && participant.guid in settings.decrypted.nicknames) {
          name = settings.decrypted.nicknames[participant.guid];
        }
        names.push(name);
      } else if (this.data.mode !== Conversation.MODE_CHAT) {
        names.push('You');
      }
    }
    return (this.data.mode === Conversation.MODE_CHAT ? '' : 'Channel with ')+names.join(', ');
  }

  async unreadCount () {
    if (this.readline == null) {
      return true;
    }

    if (this.data.lastMessage) {
      await this.data.lastMessage.ready();
      if (this.data.lastMessage.cdate <= this.readline) {
        return 0;
      }
    }

    if (!this.unreadCountPromise || this.unreadCountPromiseReadline < this.readline) {
      this.unreadCountPromiseReadline = this.readline;
      this.unreadCountPromise = Nymph.getEntities({
        'class': Message.class,
        'return': 'guid'
      }, {
        'type': '&',
        'ref': ['conversation', this.guid],
        'gt': ['cdate', this.readline]
      });
    }

    return ((await this.unreadCountPromise) || []).length;
  }

  saveReadline (...args) {
    this.readline = args[0];
    this.unreadCountPromise = null;
    return this.serverCall('saveReadline', args, true);
  }

  clearReadline (...args) {
    this.readline = null;
    this.unreadCountPromise = null;
    return this.serverCall('clearReadline', args, true);
  }

  saveNotificationSetting (...args) {
    this.notifications = args[0];
    return this.serverCall('saveNotificationSetting', args, true);
  }

  findMatchingConversations(...args) {
    return this.serverCall('findMatchingConversations', args, true);
  }

  getGroupUsers(...args) {
    return this.serverCall('getGroupUsers', args, true);
  }

  async addChannelUser(user) {
    let userKey = null;

    if (this.data.mode === Conversation.MODE_CHANNEL_PRIVATE) {
      const key = crypt.decryptRSA(this.data.keys[currentUser.guid]).slice(0, 96);
      const pad = crypt.generatePad();
      userKey = await crypt.encryptRSAForUser(key + pad, user);
    }

    return await this.serverCall('addChannelUser', [user, userKey], true);
  }

  removeChannelUser(...args) {
    return this.serverCall('removeChannelUser', args, true);
  }

  leave(...args) {
    return this.serverCall('leave', args);
  }
}

// === Static Properties ===

// The name of the server class
Conversation.class = 'Tunnelgram\\Conversation';
// Cache expiry time. 3 hours.
Conversation.CACHE_EXPIRY = 1000*60*60*3;
// Conversation modes.
Conversation.MODE_CHAT = 0;
Conversation.MODE_CHANNEL_PRIVATE = 1;
Conversation.MODE_CHANNEL_PUBLIC = 2;
Conversation.MODE_NAME = {
  [Conversation.MODE_CHAT]: `Chat`,
  [Conversation.MODE_CHANNEL_PRIVATE]: `Private Channel`,
  [Conversation.MODE_CHANNEL_PUBLIC]: `Public Channel`
};
Conversation.MODE_SHORT_NAME = {
  [Conversation.MODE_CHAT]: `Chat`,
  [Conversation.MODE_CHANNEL_PRIVATE]: `Channel`,
  [Conversation.MODE_CHANNEL_PUBLIC]: `Channel`
};
Conversation.MODE_DESCRIPTION = {
  [Conversation.MODE_CHAT]: `Chat messages are end to end encrypted per-user. Message decryption keys are copied and encrypted for each person in the chat. If someone is added to a chat later, they won't be able to read any previous messages.`,
  [Conversation.MODE_CHANNEL_PRIVATE]: `Private channel messages are end to end encrypted per-channel. Message decryption keys are derived from the channel's encryption key, which is encrypted for each person. If someone is added to a private channel later, they will be able to read all of the previous messages in the channel.`,
  [Conversation.MODE_CHANNEL_PUBLIC]: `Public channel messages are not encrypted. Anyone can search for a public channel and read its messages before joining or requesting to join.`
};
// Notification settings.
Conversation.NOTIFICATIONS_ALL = 0;
Conversation.NOTIFICATIONS_MENTIONS = 1;
Conversation.NOTIFICATIONS_DIRECT = 2;
Conversation.NOTIFICATIONS_NONE = 4;
Conversation.NOTIFICATIONS_NAME = {
  [Conversation.NOTIFICATIONS_ALL]: `Every Message`,
  // [Conversation.NOTIFICATIONS_MENTIONS]: `Mentions and Broadcasts (@here)`,
  // [Conversation.NOTIFICATIONS_DIRECT]: `Only Mentions`,
  [Conversation.NOTIFICATIONS_NONE]: `No Notifications`
};

Nymph.setEntityClass(Conversation.class, Conversation);

export default Conversation;
