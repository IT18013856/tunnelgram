<?php namespace Tunnelgram;

use Nymph\Nymph;
use Tilmeld\Tilmeld;
use Respect\Validation\Validator as v;
use Respect\Validation\Exceptions\NestedValidationException;
use Ramsey\Uuid\Uuid;

class Message extends \Nymph\Entity {
  use SendPushNotificationsTrait;
  const ETYPE = 'message';
  protected $clientEnabledMethods = [];
  protected $whitelistData = [
    'text',
    'images',
    'video',
    'key',
    'keys',
    'conversation'
  ];
  protected $protectedTags = [];
  protected $whitelistTags = [];

  /**
   * This is explicitly used only for informational messages.
   *
   * @var bool
   * @access private
   */
  private $skipAcWhenSaving = false;

  public function __construct($id = 0) {
    $this->images = [];
    $this->keys = [];
    parent::__construct($id);
  }

  public function handleDelete() {
    if (isset($this->conversation->lastMessage)
      && $this->is($this->conversation->lastMessage)
    ) {
      $this->conversation->lastMessage = Nymph::getEntity(
        [
          'class' => 'Tunnelgram\Message',
          'reverse' => true,
          'offset' => 1
        ],
        ['&',
          'ref' => ['conversation', $this->conversation]
        ]
      );
      $this->conversation->save();
    }
    // Delete images from blob store.
    if (isset($this->images) && count($this->images)) {
      include_once(__DIR__.'/../../Blob/BlobClient.php');
      $client = new BlobClient();
      foreach ($this->images as $curImg) {
        $client->delete('tunnelgram-thumbnails', $curImg['id']);
        $client->delete('tunnelgram-images', $curImg['id']);
      }
    }
    // Delete video from blob store.
    if (isset($this->video)) {
      include_once(__DIR__.'/../../Blob/BlobClient.php');
      $client = new BlobClient();
      $client->delete('tunnelgram-thumbnails', $this->video['id']);
      $client->delete('tunnelgram-videos', $this->video['id']);
    }
    return true;
  }

  public function jsonSerialize($clientClassName = true) {
    $object = parent::jsonSerialize($clientClassName);

    if (($this->informational ?? false)
      || $this->conversation->mode === Conversation::MODE_CHANNEL_PUBLIC
    ) {
      $object->mode = $this->conversation->mode;
      $object->encryption = false;
    } else {
      if ($this->conversation->mode === Conversation::MODE_CHANNEL_PRIVATE) {
        $object->data['keys'] = $this->conversation->keys;
      }

      if (Tilmeld::$currentUser !== null) {
        $ownGuid = Tilmeld::$currentUser->guid;
        $newKeys = [];
        if (array_key_exists($ownGuid, $object->data['keys'])) {
          $newKeys[$ownGuid] = $object->data['keys'][$ownGuid];
        }
        $object->data['keys'] = $newKeys;
      }

      $object->mode = $this->conversation->mode;
      $object->encryption = true;
    }

    return $object;
  }

  public function save() {
    if (!Tilmeld::gatekeeper()) {
      // Only allow logged in users to save.
      return false;
    }

    if (!$this->conversation->guid) {
      return false;
    }

    if (!Tilmeld::checkPermissions(
      $this->conversation,
      Tilmeld::WRITE_ACCESS
    )
    ) {
      return false;
    }

    if (isset($this->video) && count($this->images) > 0) {
      // Gotta be either images or video. Not both.
      return false;
    }

    if (!isset($this->guid)) {
      if ($this->conversation->mode === Conversation::MODE_CHAT) {
        $this->acRead = $this->conversation->acFull;
        $this->acOther = Tilmeld::NO_ACCESS;
      } elseif ($this->conversation->mode ===
        Conversation::MODE_CHANNEL_PRIVATE
      ) {
        $this->acRead = [$this->conversation->group];
        $this->acOther = Tilmeld::NO_ACCESS;
        unset($this->keys);
      } else {
        $this->acRead = [];
        $this->acOther = Tilmeld::READ_ACCESS;
        unset($this->keys);
      }

      if ($this->informational ?? false) {
        $this->acUser = Tilmeld::READ_ACCESS;
      }

      foreach ($this->images as &$curImg) {
        $curImg['id'] = Uuid::uuid4()->toString();
      }
      unset($curImg);

      if (isset($this->video)) {
        $this->video['id'] = Uuid::uuid4()->toString();
      }
    }

    $recipientGuids = [];
    if ($this->conversation->mode === Conversation::MODE_CHAT) {
      foreach ($this->acRead as $user) {
        $recipientGuids[] = $user->guid;
      }
    }

    if ($this->conversation->mode === Conversation::MODE_CHANNEL_PUBLIC) {
      unset($this->keys);
      unset($this->key);
    }

    if (!$this->images) {
      unset($this->images);
    }

    // This is for old messages that have a null text.
    if (!isset($this->text)) {
      unset($this->text);
    }
    // This is for old messages that have a null video.
    if (!isset($this->video)) {
      unset($this->video);
    }

    $userIsSponsor = Tilmeld::gatekeeper('tunnelgram/sponsor');
    $IMAGE_SIZE_LIMIT = $userIsSponsor ? 10485760 : 2097152;
    $VIDEO_SIZE_LIMIT = $userIsSponsor ? 62914560 : 20971520;

    try {
      // Validate.
      v::notEmpty()
        // A message that is informational is generated by the system and is not
        // encrypted.
        ->attribute('informational', v::boolType(), false)
        ->attribute('relatedUser', v::instance('\Tilmeld\Entities\User'), false)
        ->attribute(
          'key',
          v::stringType()->notEmpty()->prnt()->length(1, 2048),
          (
            !($this->informational ?? false) &&
            $this->conversation->mode === Conversation::MODE_CHANNEL_PRIVATE
          )
        )
        ->attribute(
          'keys',
          v::arrayVal()->each(
            v::stringType()->notEmpty()->prnt()->length(1, 2048),
            v::intVal()->in($recipientGuids)
          ),
          (
            !($this->informational ?? false) &&
            $this->conversation->mode === Conversation::MODE_CHAT
          )
        )
        ->when(
          v::attribute('images'),
          v::allOf(
            v::not(v::attribute('video'))
          ),
          v::alwaysValid()
        )
        ->when(
          v::attribute('video'),
          v::allOf(
            v::not(v::attribute('images'))
          ),
          v::alwaysValid()
        )
        ->attribute(
          'text',
          v::stringType()->notEmpty()->prnt()->length(
            1,
            ceil(4096 * 1.4) // Base64 of 4KiB
          ),
          false
        )
        ->attribute(
          'images',
          v::arrayVal()->length(1, 9)->each(
            v::arrayVal()->length(10, 10)->keySet(
              v::key(
                'id',
                v::regex('/'.Uuid::VALID_PATTERN.'/')
              ),
              v::key(
                'name',
                v::stringType()->notEmpty()->prnt()->length(
                  1,
                  ceil(2048 * 1.4) // Base64 of 2KiB
                )
              ),
              v::key(
                'thumbnail',
                v::oneOf(
                  v::stringType()->notEmpty()->prnt()->length(
                    1,
                    ceil(102400 * 1.4) // Base64 of 100KiB
                  ),
                  v::nullType()
                )
              ),
              v::key(
                'thumbnailType',
                v::stringType()->notEmpty()->prnt()->length(1, 50)
              ),
              v::key(
                'thumbnailWidth',
                v::stringType()->notEmpty()->prnt()->length(1, 50)
              ),
              v::key(
                'thumbnailHeight',
                v::stringType()->notEmpty()->prnt()->length(1, 50)
              ),
              v::key(
                'data',
                v::stringType()->notEmpty()->prnt()->length(
                  1,
                  ceil($IMAGE_SIZE_LIMIT * 1.4) // Base64 of image size limit
                )
              ),
              v::key(
                'dataType',
                v::stringType()->notEmpty()->prnt()->length(1, 50)
              ),
              v::key(
                'dataWidth',
                v::stringType()->notEmpty()->prnt()->length(1, 50)
              ),
              v::key(
                'dataHeight',
                v::stringType()->notEmpty()->prnt()->length(1, 50)
              )
            )
          ),
          false
        )
        ->attribute(
          'video',
          v::arrayVal()->length(11, 11)->keySet(
            v::key(
              'id',
              v::regex('/'.Uuid::VALID_PATTERN.'/')
            ),
            v::key(
              'name',
              v::stringType()->notEmpty()->prnt()->length(
                1,
                ceil(2048 * 1.4) // Base64 of 2KiB
              )
            ),
            v::key(
              'thumbnail',
              v::stringType()->notEmpty()->prnt()->length(
                1,
                ceil(409600 * 1.4) // Base64 of 400KiB
              )
            ),
            v::key(
              'thumbnailType',
              v::stringType()->notEmpty()->prnt()->length(1, 50)
            ),
            v::key(
              'thumbnailWidth',
              v::stringType()->notEmpty()->prnt()->length(1, 50)
            ),
            v::key(
              'thumbnailHeight',
              v::stringType()->notEmpty()->prnt()->length(1, 50)
            ),
            v::key(
              'data',
              v::stringType()->notEmpty()->prnt()->length(
                1,
                ceil($VIDEO_SIZE_LIMIT * 1.4) // Base64 of video size limit
              )
            ),
            v::key(
              'dataType',
              v::stringType()->notEmpty()->prnt()->length(1, 50)
            ),
            v::key(
              'dataWidth',
              v::stringType()->notEmpty()->prnt()->length(1, 50)
            ),
            v::key(
              'dataHeight',
              v::stringType()->notEmpty()->prnt()->length(1, 50)
            ),
            v::key(
              'dataDuration',
              v::stringType()->notEmpty()->prnt()->length(1, 50)
            )
          ),
          false
        )
        ->attribute('conversation', v::instance('Tunnelgram\Conversation'))
        ->setName('message')
        ->assert($this->getValidatable());

      // Upload images to blob store.
      if (!isset($this->guid) && isset($this->images)) {
        include(__DIR__.'/../../Blob/BlobClient.php');
        $client = new BlobClient();
        foreach ($this->images as &$curImg) {
          if ($curImg['thumbnail'] !== null) {
            $curImg['thumbnail'] = $client->upload(
              'tunnelgram-thumbnails',
              $curImg['id'],
              base64_decode($curImg['thumbnail'])
            );
          }
          $curImg['data'] = $client->upload(
            'tunnelgram-images',
            $curImg['id'],
            base64_decode($curImg['data'])
          );
        }
        unset($curImg);
      }

      // Upload video to blob store.
      if (!isset($this->guid) && isset($this->video)) {
        include(__DIR__.'/../../Blob/BlobClient.php');
        $client = new BlobClient();
        $this->video['thumbnail'] = $client->upload(
          'tunnelgram-thumbnails',
          $this->video['id'],
          base64_decode($this->video['thumbnail'])
        );
        $this->video['data'] = $client->upload(
          'tunnelgram-videos',
          $this->video['id'],
          base64_decode($this->video['data'])
        );
      }
    } catch (NestedValidationException $exception) {
      throw new \Exception($exception->getFullMessage());
    }
    $ret = parent::save();

    if ($ret) {
      // Update the user's readline.
      $this->conversation->saveReadline($this->mdate);

      if (!($this->informational ?? false)) {
        $this->conversation->refresh();
        $this->conversation->lastMessage = $this;
        $this->conversation->save();
      }

      if (count($recipientGuids) > 1) {
        $showNameProp = (
          count($this->conversation->acFull) > 2 ? 'nameFirst' : 'name'
        );
        $names = [];
        foreach ($this->conversation->acFull as $curUser) {
          $names[$curUser->guid] = $curUser->$showNameProp;
        }
        // Send push notifications to the recipients after script execution.
        $this->sendPushNotifications(
          array_diff($recipientGuids, [Tilmeld::$currentUser->guid]),
          [
            'conversationGuid' => $this->conversation->guid,
            'conversationNamed' => isset($this->conversation->name),
            'senderName' => Tilmeld::$currentUser->name,
            'names' => $names,
            'type' => ($this->informational ?? false) ? 'info' : 'message',
            'messageType' => (
              isset($this->images)
                ? 'Photo'
                : (isset($this->video) ? 'Video' : 'Message')
            )
          ]
        );
      }
    }

    return $ret;
  }

  /*
   * This should *never* be accessible on the client.
   */
  public function saveSkipAC() {
    $this->skipAcWhenSaving = true;
    return $this->save();
  }

  public function tilmeldSaveSkipAC() {
    if ($this->skipAcWhenSaving) {
      $this->skipAcWhenSaving = false;
      return true;
    }
    return false;
  }
}
