const querystring = require('querystring');
const parser = require('react-xml-parser');

import sig from './sig';
import util from './util';
import extras from './info-extras';

const VIDEO_URL = 'https://www.youtube.com/watch?v=';
const EMBED_URL = 'https://www.youtube.com/embed/';
const VIDEO_EURL = 'https://youtube.googleapis.com/v/';
const INFO_HOST = 'www.youtube.com';
const INFO_PATH = '/get_video_info';

/**
 * Gets info from a video without getting additional formats.
 *
 * @param {string} id
 * @param {Object} options
 * @param {Function(Error, Object)} callback
 */
const getBasicInfo = (_ID_OR_URL, options, callback) => {
  const id = util.getVideoID(_ID_OR_URL)
  // Try getting config from the video page first.
  const params = 'hl=' + (options.lang || 'en');
  let url = VIDEO_URL + id + '&' + params +
   '&bpctr=' + Math.ceil(Date.now() / 1000);

  // Remove header from watch page request.
  // Otherwise, it'll use a different framework for rendering content.
  const reqOptions = Object.assign({}, options.requestOptions);
  reqOptions.headers = Object.assign({}, reqOptions.headers, {
    'User-Agent': ''
  });

  fetch(url,reqOptions)
    .then(body => body.text())
    .then(body => {
      // Check if there are any errors with this video page.
      const unavailableMsg = util.between(body, '<div id="player-unavailable"', '>');
      if (unavailableMsg &&
        !/\bhid\b/.test(util.between(unavailableMsg, 'class="', '"'))) {
        // Ignore error about age restriction.
        if (!body.includes('<div id="watch7-player-age-gate-content"')) {
          return callback(Error(util.between(body,
                  '<h1 id="unavailable-message" class="message">', '</h1>').trim()));
        }
      }

      // Parse out additional metadata from this page.
      const additional = {
        // Get the author/uploader.
        author: extras.getAuthor(body),

        // Get the day the vid was published.
        published: extras.getPublished(body),

        // Get description.
        description: extras.getVideoDescription(body),

        // Get media info.
        media: extras.getVideoMedia(body),

        // Get related videos.
        related_videos: extras.getRelatedVideos(body),
      };

      const jsonStr = util.between(body, 'ytplayer.config = ', '</script>');
      let config;
      if (jsonStr) {
        config = jsonStr.slice(0, jsonStr.lastIndexOf(';ytplayer.load'));
        gotConfig(id, options, additional, config, false, callback);

      } else {
        // If the video page doesn't work, maybe because it has mature content.
        // and requires an account logged in to view, try the embed page.
        url = EMBED_URL + id + '?' + params;

        fetch(url)
          .then(body => body.text())
          .then(body => {
            config = util.between(body, 't.setConfig({\'PLAYER_CONFIG\': ', /\}(,'|\}\);)/);
            gotConfig(id, options, additional, config, true, callback);
          })
          .catch(err => {
            callback(err);
          });
      }
    })
    .catch(error => {
      callback(error);
    });
};


/**
 * @param {Object} info
 * @return {Array.<Object>}
 */
const parseFormats = (info) => {
  let formats = [];
  if (info.player_response.streamingData) {
    if (info.player_response.streamingData.formats) {
      formats = formats.concat(info.player_response.streamingData.formats);
    }
    if (info.player_response.streamingData.adaptiveFormats) {
      formats = formats.concat(info.player_response.streamingData.adaptiveFormats);
    }
  }
  return formats;
};


/**
 * @param {Object} id
 * @param {Object} options
 * @param {Object} additional
 * @param {Object} config
 * @param {boolean} fromEmbed
 * @param {Function(Error, Object)} callback
 */
const gotConfig = (id, options, additional, config, fromEmbed, callback) => {
  if (!config) {
    return callback(Error('Could not find player config'));
  }
  try {
    config = JSON.parse(config + (fromEmbed ? '}' : ''));
  } catch (err) {
    return callback(Error('Error parsing config: ' + err.message));
  }

  fetch(
    'https://' +
      INFO_HOST +
      INFO_PATH +
      '?' +
      querystring.stringify({
        video_id: id,
        eurl: VIDEO_EURL + id,
        ps: 'default',
        gl: 'US',
        hl: (options.lang || 'en'),
        sts: config.sts,
      })
  )
    .then(body => body.text())
    .then(body => {
      let info = querystring.parse(body);
      const player_response = config.args.player_response || info.player_response;

      if (info.status === 'fail') {
          return callback(
            Error(`Code ${info.errorcode}: ${util.stripHTML(info.reason)}`));
      } else try {
        info.player_response = JSON.parse(player_response);
      } catch (err) {
        return callback(
          Error('Error parsing `player_response`: ' + err.message));
      }
      let playability = info.player_response.playabilityStatus;
      if (playability && playability.status === 'UNPLAYABLE') {
        return callback(Error(playability.reason));
      }

      info.formats = parseFormats(info);

      // Add additional properties to info.
      Object.assign(info, additional, {
        video_id: id,

        // Give the standard link to the video.
        video_url: VIDEO_URL + id,

        // Copy over a few props from `player_response.videoDetails`
        // for backwards compatibility.
        title: info.player_response.videoDetails.title,
        length_seconds: info.player_response.videoDetails.lengthSeconds,
      });
      info.age_restricted = fromEmbed;
      info.html5player = config.assets.js;

      callback(null, info);
    })
    .catch(err => {
      callback(err);
    });
};


/**
 * Gets info fro      if (config.args.dashmpd && info.dashmpd !== config.args.dashmpd) {
        info.dashmpd2 = config.args.dashmpd;
      }m a video additional formats and deciphered URLs.
 *
 * @param {string} id
 * @param {Object} options
 * @param {Function(Error, Object)} callback
 */
const getFullInfo = (id, options, callback) => {
  return getBasicInfo(id, options, (err, info) => {
    if (err) return callback(err);
    const hasManifest =
      info.player_response && info.player_response.streamingData && (
        info.player_response.streamingData.dashManifestUrl ||
        info.player_response.streamingData.hlsManifestUrl
      );
    if (info.formats.length || hasManifest) {
      const html5playerfile = 'https://' + INFO_HOST + info.html5player;

      sig.getTokens(html5playerfile, options, (err, tokens) => {
        if (err) return callback(err);

        sig.decipherFormats(info.formats, tokens, options.debug);
        let funcs = [];
        if (hasManifest && info.player_response.streamingData.dashManifestUrl) {
          let url = info.player_response.streamingData.dashManifestUrl;
          funcs.push(getDashManifest.bind(null, url, options));
        }
        if (hasManifest && info.player_response.streamingData.hlsManifestUrl) {
          let url = info.player_response.streamingData.hlsManifestUrl;
          funcs.push(getM3U8.bind(null, url, options));
        }

        util.parallel(funcs, (err, results) => {
          if (err) return callback(err);
          if (results[0]) { mergeFormats(info, results[0]); }
          if (results[1]) { mergeFormats(info, results[1]); }

          info.formats = info.formats.map(util.addFormatMeta);

          info.formats.forEach(util.addFormatMeta);
          info.formats.sort(util.sortFormats);
          info.full = true;
          callback(null, info);
        });
      });
    } else {
      callback(Error('This video is unavailable'));
    }
  });
};


/**
 * Merges formats from DASH or M3U8 with formats from video info page.
 *
 * @param {Object} info
 * @param {Object} formatsMap
 */
const mergeFormats = (info, formatsMap) => {
  info.formats.forEach((f) => {
    formatsMap[f.itag] = f;
  });
  info.formats = Object.values(formatsMap);
};


/**
 * Gets additional DASH formats.
 *
 * @param {string} url
 * @param {Object} options
 * @param {Function(!Error, Array.<Object>)} callback
 */
const getDashManifest = (url, options, callback) => {
  let formats = {};

  const reqOptions = Object.assign({}, options.requestOptions);
  reqOptions.headers = Object.assign({}, reqOptions.headers, {
    "Content-Type": "text/plain;charset=UTF-8"
  });

  fetch(url, reqOptions)
    .then(body => body.text())
    .then((chunk) => {
      const xml = new parser().parseFromString(chunk);
      const allNodes = xml.getElementsByTagName('REPRESENTATION')
      allNodes.forEach(
        node => {
            const itag = node.attributes.id;
            formats[itag] = { itag, url };
        });

      callback(null, formats);
    })
    .catch(err => {
      callback(err);
    })
};


/**
 * Gets additional formats.
 *
 * @param {string} url
 * @param {Object} options
 * @param {Function(!Error, Array.<Object>)} callback
 */
const getM3U8 = (url, options, callback) => {
  url = 'https://' + INFO_HOST + url;
  request(url, options.requestOptions, (err, res, body) => {
    if (err) return callback(err);

    let formats = {};
    body
      .split('\n')
      .filter((line) => /https?:\/\//.test(line))
      .forEach((line) => {
        const itag = line.match(/\/itag\/(\d+)\//)[1];
        formats[itag] = { itag: itag, url: line };
      });
    callback(null, formats);
  });
};

const info = { getBasicInfo, gotConfig, getFullInfo };
export default info;
