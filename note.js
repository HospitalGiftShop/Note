import { LightningElement, api, track, wire } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { refreshApex } from '@salesforce/apex';
import getNotes from '@salesforce/apex/NoteController.getNotes';
import saveNote from '@salesforce/apex/NoteController.saveNote';
import updateNote from '@salesforce/apex/NoteController.updateNote';
import deleteNote from '@salesforce/apex/NoteController.deleteNote';
import searchRecords from '@salesforce/apex/NoteController.searchRecords';
import getLinkedRecords from '@salesforce/apex/NoteController.getLinkedRecords';
import getRecordName from '@salesforce/apex/NoteController.getRecordName';
import getCategoryPicklistValues from '@salesforce/apex/NoteController.getCategoryPicklistValues';

export default class Note extends LightningElement {
    @api recordId;
    @api objectApiName;
    
    @track notes = [];
    @track expandedSections = []; // Array of expanded accordion section names
    @track showNewNoteForm = false;
    @track showReplyForm = false;
    @track showEditForm = false;
    @track isLoading = false;
    @track replyToNoteId = '';
    @track editingNoteId = '';
    @track editingNote = { title: '', category: '', body: '', linkedRecords: [] };
    @track newNote = { title: '', category: '', body: '', linkedRecords: [] };
    @track searchTerm = '';
    @track selectedRelatedObject = '';
    @track selectedEditRelatedObject = '';
    @track searchResults = [];
    @track categoryOptions = [];
    @track refreshKey = 0; // Cache busting key
    @track availableObjects = [
        { label: 'Account', value: 'Account' },
        { label: 'Contact', value: 'Contact' },
        { label: 'Opportunity', value: 'Opportunity' },
        { label: 'Case', value: 'Case' },
        { label: 'Lead', value: 'Lead' }
    ];
    
    // Store the wire result for refreshApex
    wiredNotesResult;
    
    @wire(getCategoryPicklistValues)
    wiredCategories({ data, error }) {
        if (data) {
            this.categoryOptions = data.map(value => ({ label: value, value: value }));
        } else if (error) {
            this.showToast('Error', 'Failed to load categories', 'error');
        }
    }
    
    connectedCallback() {
        this.loadNotes();
    }
    
    async loadNotes() {
        if (!this.recordId || !this.objectApiName) return;
        
        try {
            this.isLoading = true;
            
            // Add cache busting parameter
            const result = await getNotes({ 
                recordId: this.recordId, 
                relatedObject: this.objectApiName,
                refreshKey: this.refreshKey // This forces a fresh call
            });
            
            this.notes = await this.processNotes(result);
        } catch (error) {
            console.error('Error loading notes:', error);
            this.showToast('Error', 'Failed to load notes: ' + this.getErrorMessage(error), 'error');
            this.notes = [];
        } finally {
            this.isLoading = false;
        }
    }
    
    // Force refresh by incrementing cache key
    forceRefresh() {
        this.refreshKey = Date.now(); // Use timestamp as unique key
        return this.loadNotes();
    }
    
    async processNotes(rawNotes) {
        if (!rawNotes || !Array.isArray(rawNotes)) return [];
        
        // Preserve current expansion states
        const currentExpansionStates = new Map();
        if (this.notes && this.notes.length > 0) {
            this.notes.forEach(note => {
                currentExpansionStates.set(note.Id, note.repliesExpanded);
            });
        }
        
        const noteMap = new Map();
        const parentNotes = [];
        const expandedSectionNames = []; // Track which sections should be expanded
        
        // First pass: process parent notes
        rawNotes.forEach(note => {
            if (!note.Is_Reply__c) {
                // Check if this note was previously expanded
                const wasExpanded = currentExpansionStates.get(note.Id) || false;
                
                // Format the date for the label
                const formattedDate = new Date(note.CreatedDate).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: true
                });
                
                // Create title with right-aligned date using Unicode spacing
                const titlePadding = ' '.repeat(Math.max(0, 80 - note.Title__c.length));
                
                const parentNote = {
                    Id: note.Id,
                    Title__c: note.Title__c,
                    titleWithDate: `${note.Title__c}${titlePadding}${formattedDate}`,
                    Category__c: note.Category__c,
                    Body__c: note.Body__c,
                    Parent_Note__c: note.Parent_Note__c,
                    Is_Reply__c: note.Is_Reply__c,
                    Thread_Count__c: note.Thread_Count__c,
                    CreatedDate: note.CreatedDate,
                    CreatedBy: note.CreatedBy,
                    relatedRecordsDisplay: '',
                    linkedRecords: null,
                    isLoading: true,
                    replies: [],
                    repliesExpanded: wasExpanded, // Preserve previous state
                    repliesSectionClass: wasExpanded ? 'slds-section slds-is-open' : 'slds-section slds-is-close'
                };
                noteMap.set(note.Id, parentNote);
                parentNotes.push(parentNote);
                expandedSectionNames.push(note.Id); // Add to expanded sections
            }
        });
        
        // Second pass: process replies
        rawNotes.forEach(note => {
            if (note.Is_Reply__c && noteMap.has(note.Parent_Note__c)) {
                const replyNote = {
                    Id: note.Id,
                    Title__c: note.Title__c,
                    Category__c: note.Category__c,
                    Body__c: note.Body__c,
                    Parent_Note__c: note.Parent_Note__c,
                    Is_Reply__c: note.Is_Reply__c,
                    Thread_Count__c: note.Thread_Count__c,
                    CreatedDate: note.CreatedDate,
                    CreatedBy: note.CreatedBy,
                    relatedRecordsDisplay: '',
                    linkedRecords: null,
                    isLoading: true
                };
                noteMap.get(note.Parent_Note__c).replies.push(replyNote);
            }
        });
        
        // Set expanded sections for main notes
        this.expandedSections = expandedSectionNames;
        
        // Load related records info synchronously to avoid state issues
        await this.loadAllRelatedRecords(parentNotes);
        
        return parentNotes;
    }
    
    async loadAllRelatedRecords(notes) {
        const promises = [];
        
        for (let note of notes) {
            promises.push(this.loadRelatedRecordsForNote(note));
            
            // Load for replies too
            for (let reply of note.replies) {
                promises.push(this.loadRelatedRecordsForNote(reply));
            }
        }
        
        // Wait for all related records to load before updating state
        await Promise.all(promises);
    }
    
    async loadRelatedRecordsForNote(note) {
        try {
            const linkedRecords = await getLinkedRecords({ noteId: note.Id });
            if (linkedRecords && linkedRecords.length > 0) {
                const recordNames = linkedRecords.map(record => record.Name);
                note.relatedRecordsDisplay = recordNames.join(', ');
                note.linkedRecords = linkedRecords;
            } else {
                note.relatedRecordsDisplay = 'Current record only';
                note.linkedRecords = [];
            }
            note.isLoading = false;
        } catch (error) {
            console.error('Error loading related records for note:', note.Id, error);
            note.relatedRecordsDisplay = 'Error loading related records';
            note.linkedRecords = [];
            note.isLoading = false;
        }
    }
    
    handleNewNote() {
        this.showNewNoteForm = true;
        this.resetNewNote();
    }
    
    handleReply(event) {
        this.replyToNoteId = event.target.dataset.noteId;
        this.showReplyForm = true;
        
        const parentNote = this.notes.find(note => note.Id === this.replyToNoteId);
        if (parentNote) {
            // Auto-populate title and category from parent note, but user won't see/edit them
            this.newNote = {
                title: 'Re: ' + parentNote.Title__c,
                category: parentNote.Category__c,
                body: '',
                linkedRecords: []
            };
        } else {
            this.resetNewNote();
        }
    }
    
    handleEdit(event) {
        const noteId = event.target.dataset.noteId;
        let noteToEdit = this.notes.find(note => note.Id === noteId);
        
        if (!noteToEdit) {
            for (let parentNote of this.notes) {
                if (parentNote.replies && parentNote.replies.length > 0) {
                    noteToEdit = parentNote.replies.find(reply => reply.Id === noteId);
                    if (noteToEdit) break;
                }
            }
        }
        
        if (noteToEdit) {
            this.editingNoteId = noteId;
            this.editingNote = {
                title: noteToEdit.Title__c,
                category: noteToEdit.Category__c,
                body: noteToEdit.Body__c,
                linkedRecords: []
            };
            
            this.loadLinkedRecords(noteId);
            this.showEditForm = true;
        }
    }
    
    loadLinkedRecords(noteId) {
        getLinkedRecords({ noteId: noteId })
            .then(result => {
                this.editingNote.linkedRecords = result || [];
            })
            .catch(error => {
                console.error('Failed to load linked records:', error);
                this.editingNote.linkedRecords = [];
            });
    }
    
    handleCancel() {
        this.showNewNoteForm = false;
        this.showReplyForm = false;
        this.showEditForm = false;
        this.resetNewNote();
        this.resetEditingNote();
    }
    
    handleInputChange(event) {
        const field = event.target.dataset.field;
        this.newNote = { ...this.newNote, [field]: event.target.value };
    }
    
    handleRichTextChange(event) {
        this.newNote = { ...this.newNote, body: event.target.value };
    }
    
    handleEditInputChange(event) {
        const field = event.target.dataset.field;
        this.editingNote = { ...this.editingNote, [field]: event.target.value };
    }
    
    handleEditRichTextChange(event) {
        this.editingNote = { ...this.editingNote, body: event.target.value };
    }
    
    handleRelatedObjectChange(event) {
        this.selectedRelatedObject = event.target.value;
        this.searchTerm = '';
        this.searchResults = [];
    }
    
    handleSearchTermChange(event) {
        this.searchTerm = event.target.value;
        if (this.searchTerm.length > 2 && this.selectedRelatedObject) {
            this.performSearch();
        } else {
            this.searchResults = [];
        }
    }
    
    performSearch() {
        if (this.selectedRelatedObject && this.searchTerm) {
            searchRecords({ searchTerm: this.searchTerm, relatedObject: this.selectedRelatedObject })
                .then(result => {
                    this.searchResults = result;
                })
                .catch(error => {
                    this.showToast('Error', 'Search failed: ' + this.getErrorMessage(error), 'error');
                });
        }
    }
    
    handleAddRecord(event) {
        const recordId = event.target.dataset.recordId;
        const recordName = event.target.dataset.recordName;
        const relatedObject = event.target.dataset.objectType;
        
        const existingRecord = this.newNote.linkedRecords.find(r => r.Id === recordId);
        if (!existingRecord) {
            this.newNote.linkedRecords.push({
                Id: recordId,
                Name: recordName,
                RelatedObject: relatedObject
            });
            this.newNote = { ...this.newNote }; // Force reactivity
        }
        
        this.searchTerm = '';
        this.searchResults = [];
    }
    
    handleRemoveRecord(event) {
        const recordId = event.target.name;
        this.newNote.linkedRecords = this.newNote.linkedRecords.filter(r => r.Id !== recordId);
        this.newNote = { ...this.newNote }; // Force reactivity
    }
    
    handleEditRelatedObjectChange(event) {
        this.selectedEditRelatedObject = event.target.value;
        this.searchTerm = '';
        this.searchResults = [];
    }
    
    handleEditSearchTermChange(event) {
        this.searchTerm = event.target.value;
        if (this.searchTerm.length > 2 && this.selectedEditRelatedObject) {
            this.performEditSearch();
        } else {
            this.searchResults = [];
        }
    }
    
    performEditSearch() {
        if (this.selectedEditRelatedObject && this.searchTerm) {
            searchRecords({ searchTerm: this.searchTerm, relatedObject: this.selectedEditRelatedObject })
                .then(result => {
                    this.searchResults = result;
                })
                .catch(error => {
                    this.showToast('Error', 'Search failed: ' + this.getErrorMessage(error), 'error');
                });
        }
    }
    
    handleEditSearchTermChange(event) {
        this.searchTerm = event.target.value;
        if (this.searchTerm.length > 2) {
            this.performEditSearch();
        } else {
            this.searchResults = [];
        }
    }
    
    performEditSearch() {
        const relatedObjectElement = this.template.querySelector('[data-field="editRelatedObject"]');
        const relatedObject = relatedObjectElement ? relatedObjectElement.value : null;
        
        if (relatedObject && this.searchTerm) {
            searchRecords({ searchTerm: this.searchTerm, relatedObject: relatedObject })
                .then(result => {
                    this.searchResults = result;
                })
                .catch(error => {
                    this.showToast('Error', 'Search failed: ' + this.getErrorMessage(error), 'error');
                });
        }
    }
    
    handleEditAddRecord(event) {
        const recordId = event.target.dataset.recordId;
        const recordName = event.target.dataset.recordName;
        const relatedObject = event.target.dataset.objectType;
        
        const existingRecord = this.editingNote.linkedRecords.find(r => r.Id === recordId);
        if (!existingRecord) {
            this.editingNote.linkedRecords.push({
                Id: recordId,
                Name: recordName,
                RelatedObject: relatedObject
            });
        }
        
        this.searchTerm = '';
        this.searchResults = [];
    }
    
    handleEditRemoveRecord(event) {
        const recordId = event.target.dataset.recordId;
        this.editingNote.linkedRecords = this.editingNote.linkedRecords.filter(r => r.Id !== recordId);
    }
    
    handleToggleReplies(event) {
        // Get noteId from event target or its closest parent with data-note-id
        let noteId = event.target.dataset.noteId;
        if (!noteId) {
            const buttonElement = event.target.closest('[data-note-id]');
            noteId = buttonElement ? buttonElement.dataset.noteId : null;
        }
        
        if (!noteId) {
            console.error('Could not find noteId for toggle replies');
            return;
        }
        
        console.log('Toggling replies for note:', noteId);
        
        // Find the note and toggle its replies expansion state
        this.notes = this.notes.map(note => {
            if (note.Id === noteId) {
                const newExpandedState = !note.repliesExpanded;
                console.log('Setting repliesExpanded to:', newExpandedState);
                return {
                    ...note,
                    repliesExpanded: newExpandedState,
                    repliesSectionClass: newExpandedState ? 'slds-section slds-is-open' : 'slds-section slds-is-close'
                };
            }
            return note;
        });
        
        // Force a re-render by creating a new array reference
        this.notes = [...this.notes];
    }
    
    async handleSave() {
        if (!this.validateForm()) return;
        
        try {
            this.isLoading = true;
            
            let linkedRecordIds = this.newNote.linkedRecords.map(r => r.Id);
            let relatedObjects = this.newNote.linkedRecords.map(r => r.RelatedObject);
            
            linkedRecordIds.push(this.recordId);
            relatedObjects.push(this.objectApiName);
            
            const parentNoteId = this.showReplyForm ? this.replyToNoteId : '';
            
            await saveNote({
                title: this.newNote.title,
                category: this.newNote.category,
                body: this.newNote.body,
                parentNoteId: parentNoteId,
                linkedRecordIds: linkedRecordIds,
                relatedObjects: relatedObjects
            });
            
            this.showToast('Success', 'Note saved successfully', 'success');
            this.handleCancel();
            
            // Force refresh with new cache key
            await this.forceRefresh();
            
        } catch (error) {
            console.error('Save error:', error);
            this.showToast('Error', 'Failed to save note: ' + this.getErrorMessage(error), 'error');
        } finally {
            this.isLoading = false;
        }
    }
    
    async handleUpdateNote() {
        if (!this.validateEditForm()) return;
        
        try {
            this.isLoading = true;
            
            let linkedRecordIds = this.editingNote.linkedRecords.map(r => r.Id);
            let relatedObjects = this.editingNote.linkedRecords.map(r => r.RelatedObject);
            
            if (!linkedRecordIds.includes(this.recordId)) {
                linkedRecordIds.push(this.recordId);
                relatedObjects.push(this.objectApiName);
            }
            
            await updateNote({
                noteId: this.editingNoteId,
                title: this.editingNote.title,
                category: this.editingNote.category,
                body: this.editingNote.body,
                linkedRecordIds: linkedRecordIds,
                relatedObjects: relatedObjects
            });
            
            this.showToast('Success', 'Note updated successfully', 'success');
            this.handleCancel();
            
            // Force refresh with new cache key
            await this.forceRefresh();
            
        } catch (error) {
            console.error('Update error:', error);
            this.showToast('Error', 'Failed to update note: ' + this.getErrorMessage(error), 'error');
        } finally {
            this.isLoading = false;
        }
    }
    
    async handleDelete(event) {
        const noteId = event.target.dataset.noteId;
        
        try {
            this.isLoading = true;
            
            await deleteNote({ noteId: noteId });
            
            this.showToast('Success', 'Note deleted successfully', 'success');
            
            // Force refresh with new cache key
            await this.forceRefresh();
            
        } catch (error) {
            console.error('Delete error:', error);
            this.showToast('Error', 'Failed to delete note: ' + this.getErrorMessage(error), 'error');
        } finally {
            this.isLoading = false;
        }
    }
    
    validateForm() {
        return this.newNote.title && this.newNote.category && this.newNote.body;
    }
    
    validateEditForm() {
        return this.editingNote.title && this.editingNote.category && this.editingNote.body;
    }
    
    resetNewNote() {
        this.newNote = { title: '', category: '', body: '', linkedRecords: [] };
    }
    
    resetEditingNote() {
        this.editingNoteId = '';
        this.editingNote = { title: '', category: '', body: '', linkedRecords: [] };
    }
    
    getErrorMessage(error) {
        if (error && error.body && error.body.message) return error.body.message;
        if (error && error.message) return error.message;
        return 'Unknown error occurred';
    }
    
    showToast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
    
    get formTitle() {
        return this.showReplyForm ? 'Reply to Note' : 'New Note';
    }
    
    get hasLinkedRecords() {
        return this.newNote.linkedRecords.length > 0;
    }
    
    get hasSearchResults() {
        return this.searchResults.length > 0;
    }
    
    get hasEditLinkedRecords() {
        return this.editingNote.linkedRecords.length > 0;
    }
    
    get hasNotes() {
        return this.notes && this.notes.length > 0;
    }
}