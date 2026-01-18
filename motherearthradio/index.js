'use strict';

const libQ = require('kew');

module.exports = MotherEarthRadio;

function MotherEarthRadio(context) {
    this.context = context;
    this.commandRouter = this.context.coreCommand;
    this.logger = this.context.logger;
    this.configManager = this.context.configManager;
    
    this.state = {};
    this.sseConnection = null;
    this.metadataDelay = 0;
    this.currentChannel = 'radio';
}

MotherEarthRadio.prototype.getUIConfig = function() {
    const defer = libQ.defer();
    const self = this;
    
    const lang_code = this.commandRouter.sharedVars.get('language_code');
    
    self.commandRouter.i18nJson(
        __dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json'
    )
    .then(function(uiconf) {
        // Load current settings
        uiconf.sections[0].content[0].value = self.config.get('apiDelay') || 0;
        uiconf.sections[0].content[1].value = self.config.get('highLatencyMode') || false;
        
        defer.resolve(uiconf);
    })
    .fail(function() {
        defer.reject(new Error());
    });
    
    return defer.promise;
};

MotherEarthRadio.prototype.saveConfig = function(data) {
    const self = this;
    
    self.config.set('apiDelay', parseInt(data.apiDelay) || 0);
    self.config.set('highLatencyMode', data.highLatencyMode || false);
    
    self.metadataDelay = parseInt(data.apiDelay) || 0;
    
    // Apply high latency buffer settings if enabled
    if (data.highLatencyMode && self.mpdPlugin) {
        self.log('info', 'High Latency Mode enabled - setting MPD buffer to 16MB');
        self.mpdPlugin.config.set('audio_buffer_size', 16384); // 16MB for unstable networks
    } else if (self.mpdPlugin) {
        self.log('info', 'Normal mode - setting MPD buffer to 4MB');
        self.mpdPlugin.config.set('audio_buffer_size', 4096); // 4MB default
    }
    
    self.commandRouter.pushToastMessage('success', 'Mother Earth Radio', 'Configuration saved');
    
    return libQ.resolve();
};

MotherEarthRadio.prototype.getChannelConfig = function() {
    return {
        radio: {
            name: 'Mother Earth Radio',
            streams: {
                flac192: 'https://motherearth.streamserver24.com/listen/motherearth/motherearth.flac192',
                flac96: 'https://motherearth.streamserver24.com/listen/motherearth/motherearth.flac96',
                aac: 'https://motherearth.streamserver24.com/listen/motherearth/motherearth.aac'
            },
            api: {
                nowplaying: 'https://motherearth.streamserver24.com/api/nowplaying/motherearth',
                sse: 'https://motherearth.streamserver24.com/api/live/nowplaying/sse?cf_connect=%7B%22subs%22%3A%7B%22station%3Amothereaerth%22%3A%7B%7D%7D%7D'
            }
        },
        instrumental: {
            name: 'Mother Earth Instrumental',
            streams: {
                flac192: 'https://motherearth.streamserver24.com/listen/motherearth_instrumental/motherearth.instrumental.flac192',
                flac96: 'https://motherearth.streamserver24.com/listen/motherearth_instrumental/motherearth.instrumental.flac96',
                aac: 'https://motherearth.streamserver24.com/listen/motherearth_instrumental/motherearth.instrumental.aac'
            },
            api: {
                nowplaying: 'https://motherearth.streamserver24.com/api/nowplaying/motherearth_instrumental',
                sse: 'https://motherearth.streamserver24.com/api/live/nowplaying/sse?cf_connect=%7B%22subs%22%3A%7B%22station%3Amothereaerth_instrumental%22%3A%7B%7D%7D%7D'
            }
        },
        classical: {
            name: 'Mother Earth Classical',
            streams: {
                flac192: 'https://motherearth.streamserver24.com/listen/motherearth_classical/motherearth.classical.flac192',
                flac96: 'https://motherearth.streamserver24.com/listen/motherearth_classical/motherearth.classical.flac96',
                aac: 'https://motherearth.streamserver24.com/listen/motherearth_classical/motherearth.classical.aac'
            },
            api: {
                nowplaying: 'https://motherearth.streamserver24.com/api/nowplaying/motherearth_classical',
                sse: 'https://motherearth.streamserver24.com/api/live/nowplaying/sse?cf_connect=%7B%22subs%22%3A%7B%22station%3Amothereaerth_classical%22%3A%7B%7D%7D%7D'
            }
        },
        jazz: {
            name: 'Mother Earth Jazz',
            streams: {
                flac192: 'https://motherearth.streamserver24.com/listen/motherearth_jazz/motherearth.jazz.flac192',
                flac96: 'https://motherearth.streamserver24.com/listen/motherearth_jazz/motherearth.jazz.flac96',
                aac: 'https://motherearth.streamserver24.com/listen/motherearth_jazz/motherearth.jazz.aac'
            },
            api: {
                nowplaying: 'https://motherearth.streamserver24.com/api/nowplaying/motherearth_jazz',
                sse: 'https://motherearth.streamserver24.com/api/live/nowplaying/sse?cf_connect=%7B%22subs%22%3A%7B%22station%3Amothereaerth_jazz%22%3A%7B%7D%7D%7D'
            }
        }
    };
};

// ═══════════════════════════════════════════════════════════════════════════
// VOLUMIO LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

MotherEarthRadio.prototype.onVolumioStart = function() {
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    this.config.loadFile(configFile);
    this.channels = this.getChannelConfig();
    return libQ.resolve();
};

MotherEarthRadio.prototype.onStart = function() {
    this.mpdPlugin = this.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
    
    this.loadI18nStrings();
    this.addToBrowseSources();
    
    this.metadataDelay = this.config.get('apiDelay') || 0;
    
    this.log('info', 'Plugin started successfully (SSE mode)');
    return libQ.resolve();
};

MotherEarthRadio.prototype.onStop = function() {
    this.stopSSE();
    this.removeFromBrowseSources();
    this.log('info', 'Plugin stopped');
    return libQ.resolve();
};

MotherEarthRadio.prototype.getConfigurationFiles = function() {
    return ['config.json'];
};

// ═══════════════════════════════════════════════════════════════════════════
// SSE (SERVER-SENT EVENTS) - Real-time metadata from AzuraCast
// ═══════════════════════════════════════════════════════════════════════════

MotherEarthRadio.prototype.startSSE = function(channelKey) {
    this.stopSSE();
    
    const channel = this.channels[channelKey];
    if (!channel) return;

    const sseUrl = channel.api.sse;
    this.log('info', `Starting SSE connection: ${sseUrl}`);

    const https = require('https');
    const urlParsed = new URL(sseUrl);

    const request = https.request({
        hostname: urlParsed.hostname,
        path: urlParsed.pathname + urlParsed.search,
        method: 'GET',
        headers: { 'Accept': 'text/event-stream' }
    }, (res) => {
        let buffer = '';

        res.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.substring(6));
                        
                        // 🔥 IGNORE EMPTY SSE PINGS (Keep-Alive)
                        if (!data.now_playing || !data.now_playing.song) {
                            this.log('info', 'Ignoring empty SSE ping (keep-alive)');
                            continue;
                        }
                        
                        // Valid metadata with actual song data
                        this.handleMetadata(data);
                    } catch (e) {
                        this.log('error', 'SSE parse error: ' + e.message);
                    }
                }
            }
        });

        res.on('end', () => {
            this.log('warn', 'SSE connection ended, reconnecting in 5s...');
            setTimeout(() => this.startSSE(channelKey), 5000);
        });
    });

    request.on('error', (e) => {
        this.log('error', 'SSE connection error: ' + e.message);
        setTimeout(() => this.startSSE(channelKey), 10000);
    });

    request.end();
    this.sseConnection = request;
};

MotherEarthRadio.prototype.stopSSE = function() {
    if (this.sseConnection) {
        this.sseConnection.destroy();
        this.sseConnection = null;
        this.log('info', 'SSE connection stopped');
    }
};

MotherEarthRadio.prototype.handleMetadata = function(data) {
    if (!data.now_playing || !data.now_playing.song) return;

    const song = data.now_playing.song;
    const delay = this.metadataDelay * 1000;

    setTimeout(() => {
        this.pushMetadata(song);
    }, delay);
};

MotherEarthRadio.prototype.pushMetadata = function(song) {
    const albumart = song.art || '/albumart?sourceicon=music_service/motherearthradio/mer-logo-cube-bold-1x 512.png';
    
    const state = {
        status: 'play',
        service: 'motherearthradio',
        title: song.title || 'Mother Earth Radio',
        artist: song.artist || '',
        album: song.album || '',
        albumart: albumart,
        uri: this.state.uri || 'motherearthradio/radio/flac192',
        trackType: 'flac',
        type: 'webradio',
        radioType: 'mer',
        disableUiControls: true,
        seek: 0,
        duration: 0,
        samplerate: this.getSampleRate(this.getQualityFromUri(this.state.uri)),
        bitdepth: this.getBitDepth(this.getQualityFromUri(this.state.uri)),
        channels: 2
    };

    // Workaround: Modify queue item directly to force UI update
    if (this.commandRouter.stateMachine && 
        this.commandRouter.stateMachine.currentPlaybackMetadata) {
        const currentItem = this.commandRouter.stateMachine.currentPlaybackMetadata;
        currentItem.title = state.title;
        currentItem.artist = state.artist;
        currentItem.album = state.album;
        currentItem.albumart = state.albumart;
    }

    this.commandRouter.servicePushState(state, 'motherearthradio');
    this.log('info', `Metadata: ${song.artist} - ${song.title}`);
};

// ═══════════════════════════════════════════════════════════════════════════
// BROWSE
// ═══════════════════════════════════════════════════════════════════════════

MotherEarthRadio.prototype.addToBrowseSources = function() {
    this.commandRouter.volumioAddToBrowseSources({
        name: 'Mother Earth Radio',
        uri: 'motherearthradio',
        plugin_type: 'music_service',
        plugin_name: 'motherearthradio',
        albumart: '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg'
    });
};

MotherEarthRadio.prototype.removeFromBrowseSources = function() {
    this.commandRouter.volumioRemoveToBrowseSources('motherearthradio');
};

MotherEarthRadio.prototype.handleBrowseUri = function(curUri) {
    const defer = libQ.defer();
    const self = this;
    const response = {
        navigation: {
            lists: [{
                availableListViews: ['list'],
                items: []
            }]
        }
    };

    const parts = curUri.split('/');

    if (parts.length === 1) {
        // Root: Show all channels
        response.navigation.lists[0].items = Object.keys(this.channels).map(key => {
            const channel = this.channels[key];
            return {
                service: 'motherearthradio',
                type: 'folder',
                title: channel.name,
                artist: '',
                album: '',
                icon: 'fa fa-folder-open-o',
                uri: `motherearthradio/${key}`
            };
        });
    } else if (parts.length === 2) {
        // Channel level: Show quality options
        const channelKey = parts[1];
        const channel = this.channels[channelKey];
        
        if (channel) {
            response.navigation.lists[0].items = [
                {
                    service: 'motherearthradio',
                    type: 'webradio',
                    title: `${channel.name} - FLAC 192kHz/24bit`,
                    artist: '',
                    album: '',
                    icon: 'fa fa-music',
                    uri: `motherearthradio/${channelKey}/flac192`
                },
                {
                    service: 'motherearthradio',
                    type: 'webradio',
                    title: `${channel.name} - FLAC 96kHz/24bit`,
                    artist: '',
                    album: '',
                    icon: 'fa fa-music',
                    uri: `motherearthradio/${channelKey}/flac96`
                },
                {
                    service: 'motherearthradio',
                    type: 'webradio',
                    title: `${channel.name} - AAC 96kHz`,
                    artist: '',
                    album: '',
                    icon: 'fa fa-music',
                    uri: `motherearthradio/${channelKey}/aac`
                }
            ];
        }
    }

    defer.resolve(response);
    return defer.promise;
};

// ═══════════════════════════════════════════════════════════════════════════
// PLAYBACK
// ═══════════════════════════════════════════════════════════════════════════

MotherEarthRadio.prototype.clearAddPlayTrack = function(track) {
    const defer = libQ.defer();
    const self = this;

    self.commandRouter.pushConsoleMessage('[MER] clearAddPlayTrack: ' + track.uri);

    const channelKey = self.getChannelFromUri(track.uri);
    const quality = self.getQualityFromUri(track.uri);
    const streamUrl = self.getStreamUrl(channelKey, quality);

    if (!streamUrl) {
        self.log('error', 'Invalid stream URL for: ' + track.uri);
        defer.reject();
        return defer.promise;
    }

    // Start SSE connection for this channel
    self.startSSE(channelKey);
    self.currentChannel = channelKey;

    const channel = self.channels[channelKey];
    const albumart = '/albumart?sourceicon=music_service/motherearthradio/motherearthlogo.svg';

    self.state = {
        status: 'play',
        service: 'motherearthradio',
        title: channel.name,
        artist: '',
        album: '',
        albumart: albumart,
        uri: track.uri,
        trackType: quality === 'aac' ? 'aac' : 'flac',
        type: 'webradio',
        radioType: 'mer',
        disableUiControls: true,
        seek: 0,
        duration: 0,
        samplerate: self.getSampleRate(quality),
        bitdepth: self.getBitDepth(quality),
        channels: 2
    };

    const mpdStream = {
        uri: streamUrl,
        service: 'motherearthradio',
        name: channel.name + ' - ' + self.getQualityLabel(quality),
        type: 'webradio'
    };

    self.commandRouter.pushConsoleMessage('[MER] Streaming: ' + streamUrl);

    return self.mpdPlugin.sendMpdCommand('stop', [])
        .then(() => self.mpdPlugin.sendMpdCommand('clear', []))
        .then(() => self.mpdPlugin.sendMpdCommand('load "' + mpdStream.uri + '"', []))
        .fail((e) => {
            return self.mpdPlugin.sendMpdCommand('add "' + mpdStream.uri + '"', []);
        })
        .then(() => {
            self.commandRouter.stateMachine.setConsumeUpdateService(undefined);
            return self.mpdPlugin.sendMpdCommand('play', []);
        })
        .then(() => {
            self.commandRouter.servicePushState(self.state, 'motherearthradio');
            defer.resolve();
        })
        .fail((e) => {
            self.log('error', 'Playback error: ' + e);
            defer.reject(e);
        });
};

MotherEarthRadio.prototype.stop = function() {
    this.stopSSE();
    this.commandRouter.stateMachine.setConsumeUpdateService('mpd', true, false);
    return this.mpdPlugin.stop();
};

MotherEarthRadio.prototype.pause = function() {
    return this.mpdPlugin.pause();
};

MotherEarthRadio.prototype.resume = function() {
    return this.mpdPlugin.resume();
};

MotherEarthRadio.prototype.seek = function(position) {
    return libQ.resolve();
};

MotherEarthRadio.prototype.next = function() {
    return libQ.resolve();
};

MotherEarthRadio.prototype.previous = function() {
    return libQ.resolve();
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

MotherEarthRadio.prototype.getChannelFromUri = function(uri) {
    if (!uri) return 'radio';
    const parts = uri.split('/');
    if (parts[0] === 'motherearthradio' && parts.length >= 2) {
        if (this.channels[parts[1]]) return parts[1];
    }
    return 'radio';
};

MotherEarthRadio.prototype.getQualityFromUri = function(uri) {
    if (!uri) return 'flac192';
    const parts = uri.split('/');
    if (parts[0] === 'motherearthradio' && parts.length >= 3) {
        if (['flac192', 'flac96', 'aac'].indexOf(parts[2]) >= 0) {
            return parts[2];
        }
    }
    return 'flac192';
};

MotherEarthRadio.prototype.getStreamUrl = function(channelKey, quality) {
    const channel = this.channels[channelKey];
    if (!channel) return null;
    return channel.streams[quality] || channel.streams.flac192;
};

MotherEarthRadio.prototype.getQualityLabel = function(quality) {
    if (quality === 'flac192') return 'FLAC 192kHz/24bit';
    if (quality === 'flac96') return 'FLAC 96kHz/24bit';
    if (quality === 'aac') return 'AAC 96kHz';
    return quality;
};

MotherEarthRadio.prototype.getSampleRate = function(quality) {
    if (quality === 'flac192') return '192 kHz';
    if (quality === 'flac96') return '96 kHz';
    if (quality === 'aac') return '96 kHz';
    return '';
};

MotherEarthRadio.prototype.getBitDepth = function(quality) {
    if (quality === 'flac192') return '24 bit';
    if (quality === 'flac96') return '24 bit';
    return '';
};

MotherEarthRadio.prototype.loadI18nStrings = function() {
    // Placeholder for i18n
};

MotherEarthRadio.prototype.log = function(level, message) {
    this.logger.info('[MER] ' + message);
};
