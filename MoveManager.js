
function MoveManager(gameBoard, clientTeam, mode) {
	this.gameBoard = gameBoard;
	this.clientTeam = 0;
	this.players = [new PlayerData(0, 300), new PlayerData(1, 300)];
	this.moveHistory = new DMoveList(gameBoard);
	
	this.move = function(x0, y0, z0, w0, x1, y1, z1, w1, receiving=false) {
		this.mode.move.call(this, x0, y0, z0, w0, x1, y1, z1, w1, receiving);
	}
	
	this.undo = function() {
		this.mode.undo.call(this)
	}
	
	this.redo = function() {
		this.mode.redo.call(this)
	}
	
	this.canMove = function(team) {
		return this.mode.canMove.call(this, team);
	}
	
	this.inCheck = function() {
		if (this.gameBoard.inCheck(0)) {
			return 0;
		} else if (this.gameBoard.inCheck(1)) {
			return 1;
		} else {
			return -1;
		}
	}
	
	this.winCondition = function() {
		return this.gameBoard.winCondition();
	}
	
	this.updateSelectability = function() {
		this.mode.updateSelectability.call(this);
	}
	
	this.moveStatus = function() {
		return this.mode.moveStatus.call(this);
	}
	
	this.updateUI = function() {
		// Try to update React UI (if it exists)
		// Note: toolbarProxy is not used in our implementation, skip it
		// try {
		// 	if (typeof window !== 'undefined' && typeof window.toolbarProxy !== 'undefined' && window.toolbarProxy && window.toolbarProxy.setState) {
		// 		window.toolbarProxy.setState({
		// 			text: this.moveStatus()
		// 		});
		// 	}
		// } catch (e) {
		// 	// toolbarProxy doesn't exist, ignore
		// }
		
		// Update HTML status display
		const statusText = this.moveStatus();
		const statusElement = document.getElementById('turn-text');
		if (statusElement) {
			// Use moveStatus() which already formats it correctly
			statusElement.textContent = statusText;
			console.log('🔄 Updated turn-text to:', statusText, 'whoseTurn:', this.whoseTurn());
		} else {
			console.warn('⚠️ turn-text element not found!');
		}
		
		// Update turn icon and indicator styling
		const turnIndicator = document.getElementById('turn-indicator');
		const turnIcon = document.getElementById('turn-icon');
		if (turnIcon && turnIndicator) {
			const currentTeam = this.whoseTurn();
			turnIcon.textContent = currentTeam === 0 ? '♔' : '♚';
			
			// Update indicator class for styling
			turnIndicator.classList.remove('white-turn', 'black-turn');
			if (currentTeam === 0) {
				turnIndicator.classList.add('white-turn');
			} else {
				turnIndicator.classList.add('black-turn');
			}
		}
		
		// Update turn number
		const turnNumber = document.getElementById('turn-number');
		if (turnNumber) {
			// Turn number = (move count / 2) + 1, rounded up
			const moveCount = this.size();
			const turnNum = Math.floor(moveCount / 2) + 1;
			turnNumber.textContent = turnNum;
		}
		
		// Update current player
		const currentPlayer = document.getElementById('current-player');
		if (currentPlayer) {
			const team = this.whoseTurn();
			currentPlayer.textContent = team === 0 ? 'White' : 'Black';
		}
		
		// Update check status
		const checkStatus = document.getElementById('check-status');
		if (checkStatus) {
			const checked = this.inCheck();
			if (checked === 0) {
				checkStatus.textContent = 'White in check';
			} else if (checked === 1) {
				checkStatus.textContent = 'Black in check';
			} else {
				checkStatus.textContent = 'No check';
			}
		}
	}
	
	this.currTurn = function() {
		// the turn being viewed
		return this.moveHistory.currTurn();
	}
	
	this.whoseTurnViewed = function() {
		return this.currTurn() % 2;
	}
	
	this.whoseTurn = function() {
		// Use currTurn() (current position) instead of size() (total moves)
		// This ensures correct turn after undo/redo operations
		return this.currTurn() % 2;
	}
	
	this.size = function() {
		return this.moveHistory.size();
	}
	
	this.turnString = function() {
		return "Move " + this.currTurn() + "/" + this.size();
	}
	
	this.viewingMostRecentMove = function() {
		return this.currTurn() === this.size();
	}
	
	this.setSelectability = function(team, canSelect) {
		this.gameBoard.setSelectability(team, canSelect);
	}
	
	this.setMode = function(mode) {
		this.mode = mode;
		this.mode.updateSelectability.call(this);
	}
	
	this.setMode(mode)
	
	function PlayerData(team, clockTime){
		this.team = team;
		this.clockTime = clockTime;
	}
	
	this.update = function(){
		this.players[this.whoseTurn()].clockTime -= step;
		
		if(main) backendMoveManager.update();
	}
	
	this.package = function() {
		/*
		 * Serialize data so server can send game state to clients
		 */
		let data = {
			moveHistory: this.moveHistory.package(),
			players: this.players,
			pieces: this.gameBoard.package()
		}
		return data
	}
	
	this.loadFrom = function(json) {
		Object.assign(this.players, json.players);
//		let newMoveHistory = Move.convertFromJson(json.moveHistory)
		this.moveHistory = DMoveList.fromList(json.moveHistory, this.gameBoard);
		this.gameBoard.loadPieces(json.pieces);

		// CodeQL #7 (missing-variable-declaration): legacy multiplayer-load
		// path. `Pointer`, `scene`, `camera` are undefined globals from
		// older client-side code; this whole branch is currently dead
		// (no multiplayer save/load is wired in chess4D-OC). Adding
		// `let` prevents implicit-global assignment if the path ever
		// re-activates and silences CodeQL. Doesn't fix the dangling
		// references — those need a real audit if multiplayer is revived.
		let pointer = new Pointer(scene, camera, this.gameBoard, this);
		console.log(pointer);
	}
	
	this.loadFromPlayerAssignment = function(playerAssignment) {
		this.clientTeam = playerAssignment.clientTeam;
		if (!this.ready) {
			this.ready = playerAssignment.ready;
		}
		if (playerAssignment.gameData) {
			this.loadFrom(playerAssignment.gameData);
		}
		this.updateUI();
		this.updateSelectability();
		// uiProxy is not used in our implementation
		// if (typeof uiProxy !== 'undefined' && uiProxy.exitMenu) {
		// 	uiProxy.exitMenu();
		// }
	}
}

function DMoveList(gameBoard, curr){
	this.root = new MoveHistoryNode();
	this.curr = curr || this.root;
	this.gameBoard = gameBoard;
}

DMoveList.prototype = {
	add: function(x0, y0, z0, w0, x1, y1, z1, w1, metaData, appendToEnd=false){
		return this.addMoveObj(new Move(x0, y0, z0, w0, x1, y1, z1, w1, metaData));
	},
	
	addMoveObj: function(move, appendToEnd=false) {
		const newMoveHistoryNode = new MoveHistoryNode(move);
		if (appendToEnd) {
			let end = this.curr;
			while(end.next != null) {
				end = end.next;
			}
			newMoveHistoryNode.prev = end;
			end.next = newMoveHistoryNode;
		} else {
			newMoveHistoryNode.prev = this.curr;
			this.curr.next = newMoveHistoryNode;
			this.curr = newMoveHistoryNode;
		}
		return newMoveHistoryNode;
	},
	
	undo: function(){
		if(this.curr.prev){
			this.gameBoard.undo(this.curr.move);
			this.curr = this.curr.prev;
			return true;
		}
		return false;
	},
	
	redo: function(){
		if(this.curr.next){
			this.curr = this.curr.next;
			const x0 = this.curr.move.x0;
			const y0 = this.curr.move.y0;
			const z0 = this.curr.move.z0;
			const w0 = this.curr.move.w0;
			const x1 = this.curr.move.x1;
			const y1 = this.curr.move.y1;
			const z1 = this.curr.move.z1;
			const w1 = this.curr.move.w1;
			this.gameBoard.move(x0, y0, z0, w0, x1, y1, z1, w1);
			return true;
		}
		return false;
	},
	
	size: function() {
		let size = -1;
		let curr = this.root;
		while (curr != null) {
			curr = curr.next;
			size++;
		}
		return size;
	},
	
	indexOf: function(item) {
		let index = 0;
		let curr = this.root;
		while (curr != null) {
			if (curr == item) {
				return index;
			}
			curr = curr.next;
			index++;
		}
		return -1;
	},
	
	currTurn: function() {
		return this.indexOf(this.curr);
	},
	
	toList: function() {
		let list = []
		let curr = this.root;
		while (curr != null) {
			list.push(curr.move)
			curr = curr.next;
		}
		return list;
	},
	
	package: function() {
		return this.toList();
	}
}

DMoveList.fromList = function(list, gameBoard) {
	let newDMoveList = new DMoveList(gameBoard);
	for (let i = 1; i < list.length; i++) {
		newDMoveList.addMoveObj(list[i])
	}
	return newDMoveList;
}

function MoveHistoryNode(move){
	this.move = move || null;
	this.next = null;
	this.prev = null;
	
	this.package = function() {
		return {move: this.move ? this.move.package() : null}
	}
}

function Move(x0, y0, z0, w0, x1, y1, z1, w1, metaData){
	this.x0 = x0;
	this.y0 = y0;
	this.z0 = z0;
	this.w0 = w0;
	this.x1 = x1;
	this.y1 = y1;
	this.z1 = z1;
	this.w1 = w1;
	
	this.metaData = metaData || {promotion: false};
	
	this.package = function() {
		return {
			x0: this.x0,
			y0: this.y0,
			z0: this.z0,
			w0: this.w0,
			x1: this.x1,
			y1: this.y1,
			z1: this.z1,
			w1: this.w1,
//			capturedPiece: this.capturedPiece.package(),
			metaData: (function(){
				let ret = {}
				for(var key in this.metaData) {
					if(this[key] && this[key] instanceof Piece) {
						ret[key] = this[key].package();
					} else {
						ret[key] = this[key];
					}
				}
				return ret;
			}.bind(this))()
		}
	}
}