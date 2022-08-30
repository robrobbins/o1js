import {
  Field,
  SmartContract,
  state,
  State,
  method,
  DeployArgs,
  Permissions,
  Experimental,
  PublicKey,
  Circuit,
  Bool,
} from 'snarkyjs';

import { Member } from './member';
import {
  ElectionPreconditions,
  ParticipantPreconditions,
} from './preconditions';
import { Membership_ } from './membership';

/**
 * Address to the Membership instance that keeps track of Candidates.
 */
let candidateAddress = PublicKey.empty();

/**
 * Address to the Membership instance that keeps track of Voters.
 */
let voterAddress = PublicKey.empty();

/**
 * Requirements in order for a Member to participate in the election as a Candidate.
 */
let candidatePreconditions = ParticipantPreconditions.default;

/**
 * Requirements in order for a Member to participate in the election as a Voter.
 */
let voterPreconditions = ParticipantPreconditions.default;

/**
 * Defines the preconditions of an election.
 */
let electionPreconditions = ElectionPreconditions.default;

interface VotingParams {
  electionPreconditions: ElectionPreconditions;
  voterPreconditions: ParticipantPreconditions;
  candidatePreconditions: ParticipantPreconditions;
  candidateAddress: PublicKey;
  voterAddress: PublicKey;
  contractAddress: PublicKey;
  doProofs: boolean;
}

/**
 * Returns a new contract instance that based on a set of preconditions.
 * @param params {@link Voting_}
 */
export async function Voting(params: VotingParams): Promise<Voting_> {
  electionPreconditions = params.electionPreconditions;
  voterPreconditions = params.voterPreconditions;
  candidatePreconditions = params.candidatePreconditions;
  candidateAddress = params.candidateAddress;
  voterAddress = params.voterAddress;

  let contract = new Voting_(params.contractAddress);
  if (params.doProofs) {
    await Voting_.compile(params.contractAddress);
  }
  return contract;
}

export class Voting_ extends SmartContract {
  /**
   * Root of the merkle tree that stores all committed votes.
   */
  @state(Field) committedVotes = State<Field>();

  /**
   * Accumulator of all emitted votes.
   */
  @state(Field) accumulatedVotes = State<Field>();

  reducer = Experimental.Reducer({ actionType: Member });

  deploy(args: DeployArgs) {
    super.deploy(args);
    this.setPermissions({
      ...Permissions.default(),
      editState: Permissions.proofOrSignature(),
      editSequenceState: Permissions.proofOrSignature(),
    });
    this.accumulatedVotes.set(Experimental.Reducer.initialActionsHash);
  }

  /**
   * Method used to register a new voter. Calls the `addEntry(member)` method of the Voter-Membership contract.
   * @param member
   */
  @method
  voterRegistration(member: Member) {
    let currentSlot = this.network.globalSlotSinceGenesis.get();
    this.network.globalSlotSinceGenesis.assertEquals(currentSlot);

    // can only register voters before the election has started
    currentSlot.assertLte(electionPreconditions.startElection);

    // can only register voters if their balance is gte the minimum amount required
    member.balance
      .gte(voterPreconditions.minMina)
      .and(member.balance.lte(voterPreconditions.maxMina))
      .assertTrue();

    let VoterContract: Membership_ = new Membership_(voterAddress);
    let exists = VoterContract.addEntry(member);

    // the check happens here because we want to see if the other contract returns a value
    // if exists is true, that means the member already exists within the accumulated state
    // if its false, its a new entry
    exists.assertEquals(false);
  }

  /**
   * Method used to register a new candidate.
   * Calls the `addEntry(member)` method of the Candidate-Membership contract.
   * @param member
   */
  @method
  candidateRegistration(member: Member) {
    let currentSlot = this.network.globalSlotSinceGenesis.get();
    this.network.globalSlotSinceGenesis.assertEquals(currentSlot);

    // can only register candidates before the election has started
    currentSlot.assertLte(electionPreconditions.startElection);

    // can only register candidates if their balance is gte the minimum amount required
    // and lte the maximum amount
    member.balance
      .gte(candidatePreconditions.minMina)
      .and(member.balance.lte(candidatePreconditions.maxMina))
      .assertTrue();

    let CandidateContract: Membership_ = new Membership_(candidateAddress);
    let exists = CandidateContract.addEntry(member);

    // the check happens here because we want to see if the other contract returns a value
    // if exists is true, that means the member already exists within the accumulated state
    // if its false, its a new entry
    exists.assertEquals(false);
  }

  /**
   * Method used to register update all pending member registrations.
   * Calls the `publish()` method of the Candidate-Membership and Voter-Membership contract.
   */
  @method
  authorizeRegistrations() {
    // Invokes the publish method of both Voter and Candidate Membership contracts.
    let VoterContract: Membership_ = new Membership_(voterAddress);
    VoterContract.publish();

    let CandidateContract: Membership_ = new Membership_(candidateAddress);
    CandidateContract.publish();
  }

  /**
   * Method used to cast a vote to a specific candidate.
   * Dispatches a new vote sequence event.
   * @param member
   * @param member
   */
  @method
  vote(candidate: Member, voter: Member) {
    let currentSlot = this.network.globalSlotSinceGenesis.get();
    this.network.globalSlotSinceGenesis.assertEquals(currentSlot);

    // we can only vote in the election period time frame
    currentSlot
      .gte(electionPreconditions.startElection)
      .and(currentSlot.lte(electionPreconditions.endElection))
      .assertTrue();

    // verifying that both the voter and the candidate are actually part of our member set
    // ideally we would also verify a signature here, but ignoring that for now
    let VoterContract: Membership_ = new Membership_(voterAddress);
    VoterContract.isMember(voter).assertTrue();

    let CandidateContract: Membership_ = new Membership_(candidateAddress);
    CandidateContract.isMember(candidate).assertTrue();

    // emits a sequence event with the information about the candidate
    this.reducer.dispatch(candidate);
  }

  /**
   * Method used to accumulate all pending votes from sequence events
   * and applies state changes to the votes merkle tree.
   */
  @method
  countVotes() {
    let accumulatedVotes = this.accumulatedVotes.get();
    this.accumulatedVotes.assertEquals(accumulatedVotes);

    let committedVotes = this.committedVotes.get();
    this.committedVotes.assertEquals(committedVotes);

    let { state: newCommittedVotes, actionsHash: newAccumulatedVotes } =
      this.reducer.reduce(
        this.reducer.getActions({ fromActionHash: accumulatedVotes }),
        Field,
        (state: Field, _action: Member) => {
          // checking that the member is part of the merkle tree
          // TODO: make work
          let isValid = Bool(true); /* _action.witness
            .calculateRoot(_action.getHash())
            .equals(state); */

          // adding one additional vote to the member and calculating new root
          _action = _action.addVote();
          // this is the new root after we added one vote
          let newRoot = _action.votesWitness.calculateRoot(_action.getHash());

          // checking if the account was part of the tree in the first place
          // if it was, then return the new, root
          // otherwise, return the initial state
          return Circuit.if(isValid, newRoot, state);
        },
        // initial state
        { state: committedVotes, actionsHash: accumulatedVotes }
      );

    this.committedVotes.set(newCommittedVotes);
    this.accumulatedVotes.set(newAccumulatedVotes);
  }
}
