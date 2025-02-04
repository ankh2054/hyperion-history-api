import {checkFilter, hLog} from '../helpers/common_functions';
import {Server, Socket} from 'socket.io';
import {createAdapter} from 'socket.io-redis';
import {io} from 'socket.io-client';
import {FastifyInstance} from "fastify";
import IORedis from "ioredis";

export interface StreamDeltasRequest {
	code: string;
	table: string;
	scope: string;
	payer: string;
	start_from: number | string;
	read_until: number | string;
}

export interface RequestFilter {
	field: string;
	value: string;
}

export interface StreamActionsRequest {
	contract: string;
	account: string;
	action: string;
	filters: RequestFilter[];
	start_from: number | string;
	read_until: number | string;
}

async function addBlockRangeOpts(data, search_body, fastify: FastifyInstance) {

	let timeRange;
	let blockRange;
	let head;

	if (typeof data['start_from'] === 'string' && data['start_from'] !== '') {
		if (!timeRange) {
			timeRange = {"@timestamp": {}};
		}
		timeRange["@timestamp"]['gte'] = data['start_from'];
	}

	if (typeof data['read_until'] === 'string' && data['read_until'] !== '') {
		if (!timeRange) {
			timeRange = {"@timestamp": {}};
		}
		timeRange["@timestamp"]['lte'] = data['read_until'];
	}

	if (typeof data['start_from'] === 'number' && data['start_from'] !== 0) {
		if (!blockRange) {
			blockRange = {"block_num": {}};
		}
		if (data['start_from'] < 0) {
			if (!head) {
				head = (await fastify.eosjs.rpc.get_info()).head_block_num;
			}
			blockRange["block_num"]['gte'] = head + data['start_from'];
		} else {
			blockRange["block_num"]['gte'] = data['start_from'];
		}
	}

	if (typeof data['read_until'] === 'number' && data['read_until'] !== 0) {
		if (!blockRange) {
			blockRange = {"block_num": {}};
		}
		if (data['read_until'] < 0) {
			if (!head) {
				head = (await fastify.eosjs.rpc.get_info()).head_block_num;
			}
			blockRange["block_num"]['lte'] = head + data['read_until'];
		} else {
			blockRange["block_num"]['lte'] = data['read_until'];
		}
	}

	if (timeRange) {
		search_body.query.bool.must.push({
			range: timeRange,
		});
	}
	if (blockRange) {
		search_body.query.bool.must.push({
			range: blockRange,
		});
	}
}

function addTermMatch(data, search_body, field) {
	if (data[field] !== '*' && data[field] !== '') {
		const termQuery = {};
		termQuery[field] = data[field];
		search_body.query.bool.must.push({'term': termQuery});
	}
}

const deltaQueryFields = ['code', 'table', 'scope', 'payer'];

async function streamPastDeltas(fastify: FastifyInstance, socket, data) {
	const search_body = {
		query: {bool: {must: []}},
		sort: {block_num: 'asc'},
	};
	await addBlockRangeOpts(data, search_body, fastify);
	deltaQueryFields.forEach(f => {
		addTermMatch(data, search_body, f);
	});
	const responseQueue = [];
	let counter = 0;
	const init_response = await fastify.elastic.search({
		index: fastify.manager.chain + '-delta-*',
		scroll: '30s',
		size: 20,
		body: search_body,
	});
	responseQueue.push(init_response);
	while (responseQueue.length) {
		const {body} = responseQueue.shift();
		counter += body['hits']['hits'].length;
		if (socket.connected) {
			socket.emit('message', {
				type: 'delta_trace',
				mode: 'history',
				messages: body['hits']['hits'].map(doc => doc._source),
			});
		} else {
			hLog('LOST CLIENT');
			break;
		}
		if (body['hits'].total.value === counter) {
			hLog(`${counter} past deltas streamed to ${socket.id}`);
			break;
		}

		const next_response = await fastify.elastic.scroll({
			body: {
				scroll_id: body['_scroll_id'],
				scroll: '30s'
			}
		});
		responseQueue.push(next_response);
	}
}

async function streamPastActions(fastify: FastifyInstance, socket, data) {
	const search_body = {
		query: {bool: {must: []}},
		sort: {global_sequence: 'asc'},
	};

	await addBlockRangeOpts(data, search_body, fastify);

	if (data.account !== '') {
		search_body.query.bool.must.push({
			bool: {
				should: [
					{term: {'notified': data.account}},
					{term: {'act.authorization.actor': data.account}},
				],
			},
		});
	}

	if (data.contract !== '*' && data.contract !== '') {
		search_body.query.bool.must.push({'term': {'act.account': data.contract}});
	}

	if (data.action !== '*' && data.action !== '') {
		search_body.query.bool.must.push({'term': {'act.name': data.action}});
	}

	const onDemandFilters = [];
	if (data.filters.length > 0) {
		data.filters.forEach(f => {
			if (f.field && f.value) {
				if (f.field.startsWith('@') && !f.field.startsWith('act.data')) {
					const _q = {};
					_q[f.field] = f.value;
					search_body.query.bool.must.push({'term': _q});
				} else {
					onDemandFilters.push(f);
				}
			}
		});
	}

	const responseQueue = [];
	let counter = 0;

	const init_response = await fastify.elastic.search({
		index: fastify.manager.chain + '-action-*',
		scroll: '30s',
		size: 20,
		body: search_body,
	});
	responseQueue.push(init_response);
	while (responseQueue.length) {
		const {body} = responseQueue.shift();
		const enqueuedMessages = [];
		counter += body['hits']['hits'].length;
		for (const doc of body['hits']['hits']) {
			let allow = false;
			if (onDemandFilters.length > 0) {
				allow = onDemandFilters.every(filter => {
					return checkFilter(filter, doc._source);
				});
			} else {
				allow = true;
			}
			if (allow) {
				enqueuedMessages.push(doc._source);
			}
		}
		if (socket.connected) {
			socket.emit('message', {type: 'action_trace', mode: 'history', messages: enqueuedMessages});
		} else {
			hLog('LOST CLIENT');
			break;
		}
		if (body['hits'].total.value === counter) {
			hLog(`${counter} past actions streamed to ${socket.id}`);
			break;
		}
		if (init_response.body.hits.total.value < 1000) {
			const next_response = await fastify.elastic.scroll({
				body: {scroll_id: body['_scroll_id'], scroll: '30s'}
			});
			responseQueue.push(next_response);
		} else {
			hLog('Request too large!');
			socket.emit('message', {type: 'action_trace', mode: 'history', messages: []});
		}
	}
}

export class SocketManager {

	private io: Server;
	private relay;
	relay_restored = true;
	relay_down = false;
	private readonly url;
	private readonly server: FastifyInstance;

	constructor(fastify: FastifyInstance, url, redisOptions) {
		this.server = fastify;
		this.url = url;

		this.io = new Server(fastify.server, {
			allowEIO3: true,
			transports: ['websocket', 'polling'],
		});

		const pubClient = new IORedis(redisOptions);
		const subClient = pubClient.duplicate();
		this.io.adapter(createAdapter({pubClient, subClient}));

		this.io.on('connection', (socket: Socket) => {

			if (socket.handshake.headers['x-forwarded-for']) {
				hLog(`[socket] ${socket.id} connected via ${socket.handshake.headers['x-forwarded-for']}`);
			}

			socket.emit('message', {
				event: 'handshake',
				chain: fastify.manager.chain,
			});

			if (this.relay) {
				this.relay.emit('event', {
					type: 'client_count',
					counter: this.io.sockets.sockets.size,
				});
			}

			socket.on('delta_stream_request', async (data: StreamDeltasRequest, callback) => {
				if (typeof callback === 'function' && data) {
					try {
						if (data.start_from) {
							await streamPastDeltas(this.server, socket, data);
						}
						this.emitToRelay(data, 'delta_request', socket, callback);
					} catch (e) {
						console.log(e);
					}
				}
			});

			socket.on('action_stream_request', async (data: StreamActionsRequest, callback) => {
				if (typeof callback === 'function' && data) {
					try {
						if (data.start_from) {
							await streamPastActions(this.server, socket, data);
						}
						this.emitToRelay(data, 'action_request', socket, callback);
					} catch (e) {
						console.log(e);
					}
				}
			});

			socket.on('disconnect', (reason) => {
				hLog(`[socket] ${socket.id} disconnected - ${reason}`);
				this.relay.emit('event', {
					type: 'client_disconnected',
					id: socket.id,
					reason,
				});
			});
		});
		hLog('Websocket manager loaded!');
	}

	startRelay() {
		hLog(`starting relay - ${this.url}`);

		this.relay = io(this.url, {path: '/router'});

		this.relay.on('connect', () => {
			hLog('Relay Connected!');
			if (this.relay_down) {
				this.relay_restored = true;
				this.relay_down = false;
				this.io.emit('status', 'relay_restored');
			}
		});

		this.relay.on('disconnect', () => {
			hLog('Relay disconnected!');
			this.io.emit('status', 'relay_down');
			this.relay_down = true;
			this.relay_restored = false;
		});

		this.relay.on('delta', (traceData) => {
			this.emitToClient(traceData, 'delta_trace');
		});

		this.relay.on('trace', (traceData) => {
			this.emitToClient(traceData, 'action_trace');
		});

		// Relay LIB info to clients;
		this.relay.on('lib_update', (data) => {
			if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
				this.io.emit('lib_update', data);
			}
		});

		// Relay LIB info to clients;
		this.relay.on('fork_event', (data) => {
			hLog(data);
			if (this.server.manager.conn.chains[this.server.manager.chain].chain_id === data.chain_id) {
				this.io.emit('fork_event', data);
			}
		});
	}

	emitToClient(traceData, type) {
		if (this.io.sockets.sockets.has(traceData.client)) {
			this.io.sockets.sockets.get(traceData.client).emit('message', {
				type: type,
				mode: 'live',
				message: traceData.message,
			});
		}
	}

	emitToRelay(data, type, socket, callback) {
		if (this.relay.connected) {
			this.relay.emit('event', {
				type: type,
				client_socket: socket.id,
				request: data,
			}, (response) => {
				callback(response);
			});
		} else {
			callback('STREAMING_OFFLINE');
		}
	}
}
